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
}

fn valid_tenant_id(id: &str) -> bool {
    (1..=128).contains(&id.len()) &&
        id.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}

impl TenantRegistry {
    pub fn new(engine: Engine, module: Module, max_tenants: usize) -> Result<Self, Failure> {
        if !(1..=MAX_TENANTS).contains(&max_tenants) {
            return Err("invalid tenant admission capacity".into());
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
            .memory_size(GUEST_MEMORY_BYTES)
            .memories(1)
            .tables(0)
            .instances(1)
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
        let outcome = {
            let tenant = self.checked_mut(handle)?;
            if tenant.phase != Phase::Running {
                return Err("tenant is quiescing".into());
            }
            tenant.store.set_fuel(fuel)?;
            let main = tenant.instance
                .get_typed_func::<(), i64>(&mut tenant.store, "main")?;
            main.call(&mut tenant.store, ())
        };

        // After a guest trap, drop its Store/Instance so no state can be
        // reused accidentally. A fresh admission has a new generation.
        if outcome.is_err() {
            self.tenants.remove(&handle.id);
        }
        Ok(outcome?)
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
        for candidate in ["", "../x", "foo/bar", "a b", "a\n", "é"] {
            assert!(!valid_tenant_id(candidate), "{candidate:?}");
        }
        assert!(!valid_tenant_id(&"a".repeat(129)));
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
