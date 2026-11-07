//! Experimental native Wasmtime tenant compartments.
//!
//! A tenant owns exactly one Wasmtime Store and Instance. Stores isolate
//! WebAssembly objects and linear memories; a shared Engine/Module contains
//! compiled code, not tenant-owned mutable guest memory.
//!
//! Security scope: in-process Wasm sandbox only. This does not isolate the
//! host kernel, Wasmtime native code, process RSS, or a compromised embedding.
//! A caller-controlled SHA-256 is NOT artifact authorization. Production AOT
//! execution stays disabled until authenticated deployment and OS supervision.

use std::collections::HashMap;
use std::error::Error;
use std::sync::Arc;
use wasmtime::{Engine, Instance, Module, Store, StoreLimits, StoreLimitsBuilder};

type Failure = Box<dyn Error>;
const MAX_TENANTS: usize = 32;
const MAX_FUEL: u64 = 100_000_000;
const GUEST_MEMORY_BYTES: usize = 2 * 65536;

// Private Arc identity cannot be reconstructed from an untrusted tenant ID
// and generation. This is an in-process host capability, NOT network auth.
#[derive(Clone)]
pub struct TenantHandle {
    id: String,
    generation: u64,
    identity: Arc<()>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Running,
    Quiescing,
}

struct Tenant {
    generation: u64,
    identity: Arc<()>,
    phase: Phase,
    store: Store<StoreLimits>,
    instance: Instance,
}

pub struct TenantRegistry {
    engine: Engine,
    module: Module,
    tenants: HashMap<String, Tenant>,
    next_generation: u64,
    max_tenants: usize,
    memory_limit_bytes: usize,
}

fn valid_tenant_id(id: &str) -> bool {
    // Dot path components must not be usable as tenant identities, even
    // though this in-memory registry does not currently expose filesystem I/O.
    // Reserving them avoids authority/path collisions in future durable hosts.
    id != "." && id != ".." &&
        (1..=128).contains(&id.len()) &&
        id.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}

impl TenantRegistry {
    pub fn new(engine: Engine, module: Module, max_tenants: usize) -> Result<Self, Failure> {
        Self::with_memory_limit(engine, module, max_tenants, GUEST_MEMORY_BYTES)
    }

    // Debug-only regression: guest may grow to two pages but its Store is
    // restricted to one. Do not expose a custom Store cap in production.
    #[cfg(all(oreslang_debug_cargo_profile, debug_assertions, feature = "insecure-dev-caller-pin"))]
    pub fn new_for_growth_smoke(engine: Engine, module: Module, max_tenants: usize) -> Result<Self, Failure> {
        Self::with_memory_limit(engine, module, max_tenants, GUEST_MEMORY_BYTES / 2)
    }

    fn with_memory_limit(engine: Engine, module: Module, max_tenants: usize, memory_limit_bytes: usize) -> Result<Self, Failure> {
        if !(1..=MAX_TENANTS).contains(&max_tenants) {
            return Err("invalid tenant admission capacity".into());
        }
        if memory_limit_bytes != GUEST_MEMORY_BYTES && memory_limit_bytes != GUEST_MEMORY_BYTES / 2 {
            return Err("invalid tenant memory limit".into());
        }
        // In addition to trusted precompile-time byte admission, refuse host
        // imports, shared exported memory and unexpected exported capabilities.
        crate::profile::check_abi(&module)?;
        Ok(Self {
            engine,
            module,
            tenants: HashMap::new(),
            next_generation: 1,
            max_tenants,
            memory_limit_bytes,
        })
    }

    pub fn admit(&mut self, id: &str) -> Result<TenantHandle, Failure> {
        if !valid_tenant_id(id) {
            return Err("invalid tenant ID".into());
        }
        if self.tenants.contains_key(id) {
            return Err("tenant already admitted".into());
        }
        if self.tenants.len() >= self.max_tenants {
            return Err("tenant capacity exhausted".into());
        }
        let next = self.next_generation.checked_add(1)
            .ok_or("tenant generation exhausted")?;
        let generation = self.next_generation;

        // Prepare the entire compartment BEFORE publishing the handle.
        // Each tenant gets a distinct Store and a distinct Wasm Instance.
        let limits = StoreLimitsBuilder::new()
            .memory_size(self.memory_limit_bytes)
            .memories(1)
            .tables(0)
            .instances(1)
            // A guest that exceeds the memory cap must trap, not continue
            // after a failed memory.grow with a -1 sentinel.
            .trap_on_grow_failure(true)
            .build();
        let mut store = Store::new(&self.engine, limits);
        store.limiter(|limits| limits);
        // Fuel applies during instantiation as well. The admitted scalar
        // profile forbids start sections; each call resets its own budget.
        store.set_fuel(MAX_FUEL)?;
        let instance = Instance::new(&mut store, &self.module, &[])?;
        let identity = Arc::new(());
        let handle = TenantHandle {
            id: id.to_string(),
            generation,
            identity: Arc::clone(&identity),
        };
        self.tenants.insert(id.to_string(), Tenant {
            generation,
            identity,
            phase: Phase::Running,
            store,
            instance,
        });
        self.next_generation = next;
        Ok(handle)
    }

    fn checked_mut(&mut self, handle: &TenantHandle) -> Result<&mut Tenant, Failure> {
        let tenant = self.tenants.get_mut(&handle.id)
            .ok_or("stale or unknown tenant handle")?;
        if tenant.generation != handle.generation ||
            !Arc::ptr_eq(&tenant.identity, &handle.identity)
        {
            return Err("stale or forged tenant handle".into());
        }
        Ok(tenant)
    }

    pub fn invoke(&mut self, handle: &TenantHandle, fuel: u64) -> Result<i64, Failure> {
        if !(1..=MAX_FUEL).contains(&fuel) {
            return Err("tenant fuel outside admission bounds".into());
        }
        let tenant = self.checked_mut(handle)?;
        if tenant.phase != Phase::Running {
            return Err("tenant is quiescing".into());
        }
        // All errors after the host has authorized an execution attempt
        // must pass through one cleanup path. In particular, do NOT use
        // '?' directly on set_fuel or get_typed_func outside the closure:
        // doing so skips the Store retirement below.
        let outcome = (|| -> Result<i64, Failure> {
            tenant.store.set_fuel(fuel)?;
            let main = tenant.instance
                .get_typed_func::<(), i64>(&mut tenant.store, "main")?;
            Ok(main.call(&mut tenant.store, ())?)
        })();

        // Always retire a compartment after a failed invocation, whether
        // Wasmtime reports a trap, fuel setup error, or an ABI lookup error.
        // Retain the old identity in the external handle to fence reopening
        // a tenant with the same string ID after this Store is destroyed.
        if outcome.is_err() {
            self.tenants.remove(&handle.id);
        }
        outcome
    }

    pub fn begin_shutdown(&mut self, handle: &TenantHandle) -> Result<(), Failure> {
        let tenant = self.checked_mut(handle)?;
        if tenant.phase != Phase::Running {
            return Err("tenant already quiescing".into());
        }
        tenant.phase = Phase::Quiescing;
        Ok(())
    }

    pub fn destroy(&mut self, handle: &TenantHandle) -> Result<(), Failure> {
        let tenant = self.checked_mut(handle)?;
        if tenant.phase != Phase::Quiescing {
            return Err("tenant must quiesce before destruction".into());
        }
        // This registry is synchronously borrowed via &mut self: destruction
        // cannot overlap an invoke through its safe Rust API. Production
        // brokers must serialize/await outstanding requests before calling it.
        self.tenants.remove(&handle.id);
        Ok(())
    }

    pub fn active_tenants(&self) -> usize {
        self.tenants.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tenant_ids_are_ascii_bounded_and_never_paths() {
        assert!(valid_tenant_id("customer-1.scope_2"));
        for candidate in ["", ".", "..", "../x", "foo/bar", "a b", "a\n", "é"] {
            assert!(!valid_tenant_id(candidate), "{candidate:?}");
        }
        assert!(!valid_tenant_id(&"a".repeat(129)));
        assert!(valid_tenant_id(&"a".repeat(128)));
        // Keep the exact same host-identity grammar as Java, LLVM,
        // Cranelift and Native AOT. Never consume tenant slots on these.
        for candidate in ["tenant:other", "tenant\\other", "bad\\0name", "a%", "ténant"] {
            assert!(!valid_tenant_id(candidate), "{candidate:?}");
        }
    }

    #[test]
    fn denied_memory_growth_returns_a_trap_instead_of_a_guest_sentinel() {
        // Exercise Wasmtime's real StoreLimits policy; this is not a
        // substitute for executing a guest memory.grow in a native Store.
        let mut policy = StoreLimitsBuilder::new()
            .memory_size(GUEST_MEMORY_BYTES)
            .memories(1)
            .tables(0)
            .instances(1)
            .trap_on_grow_failure(true)
            .build();
        assert!(wasmtime::ResourceLimiter::memory_growing(
            &mut policy, GUEST_MEMORY_BYTES,
            GUEST_MEMORY_BYTES + 65536,
            Some(GUEST_MEMORY_BYTES),
        ).is_err(), "growth beyond tenant cap must fail by trap");
    }

    #[test]
    fn store_limit_denial_is_distinct_from_module_declared_maximum() {
        // Guest declares a two-page maximum and requests growth from one
        // to two pages. Only the host-imposed Store cap denies this request.
        let mut policy = StoreLimitsBuilder::new()
            .memory_size(GUEST_MEMORY_BYTES / 2)
            .trap_on_grow_failure(true)
            .build();
        let result = wasmtime::ResourceLimiter::memory_growing(
            &mut policy, GUEST_MEMORY_BYTES / 2,
            GUEST_MEMORY_BYTES, Some(GUEST_MEMORY_BYTES),
        );
        let error = result.expect_err("host quota must deny guest-permitted growth");
        assert!(error.to_string().contains("forcing trap when growing memory"));
    }

    #[test]
    fn resource_policy_is_bounded() {
        assert_eq!(MAX_TENANTS, 32);
        assert_eq!(GUEST_MEMORY_BYTES, 131072);
        assert!((1..=MAX_FUEL).contains(&1_000_000));
        assert!(!(1..=MAX_FUEL).contains(&0));
        // The real Wasmtime multi-Store proof lives in smoke.sh; constants
        // alone do not demonstrate memory separation or native execution.
    }
}
