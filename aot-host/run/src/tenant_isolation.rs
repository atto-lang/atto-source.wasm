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
// NOTE: a fresh Store/tenant gets an initial finite fuel budget. Repeated
// invoke calls conserve that logical budget: yielding, polling and retrying
// cannot restore charged fuel. This does not turn Wasmtime instruction-level
// metering into a 128/512-iteration sampling scheme.

use std::collections::HashMap;
use std::error::Error;
use std::sync::Arc;
use crate::durable_lock_queues::{DurableLockQueues, Limits as DurableQueueLimits};
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

/// Canonical AttoLang opaque per-tenant-generation handle.
/// Existing TenantHandle remains valid; this alias is NOT a new sandbox.
pub type TenantVMHandle = TenantHandle;

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
    // Conserved across all calls; scheduler handoffs must never mint new fuel.
    remaining_fuel: u64,
    // Not guest-reachable. Scheduler-issued actor capability required before use.
    durable: DurableLockQueues,
}

pub struct TenantRegistry {
    engine: Engine,
    module: Module,
    tenants: HashMap<String, Tenant>,
    next_generation: u64,
    max_tenants: usize,
    memory_limit_bytes: usize,
    initial_fuel: u64,
}

fn valid_tenant_id(id: &str) -> bool {
    // Dot path components must not be usable as tenant identities, even
    // though this in-memory registry does not currently expose filesystem I/O.
    // Reserving them avoids authority/path collisions in future durable hosts.
    id != "." && id != ".." &&
        (1..=128).contains(&id.len()) &&
        id.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}

// The call allowance can bound one invocation but cannot refill a logical
// tenant quota. Both the scheduler and the guest are unable to increase it.
fn admitted_call_fuel(remaining: u64, requested: u64) -> Result<u64, &'static str> {
    if !(1..=MAX_FUEL).contains(&requested) { return Err("tenant fuel outside admission bounds"); }
    let granted = remaining.min(requested);
    if granted == 0 { Err("tenant fuel exhausted") } else { Ok(granted) }
}

fn debit_used_fuel(remaining: &mut u64, granted: u64, unused: u64) -> Result<(), &'static str> {
    if granted == 0 || unused > granted { return Err("invalid Wasmtime fuel accounting"); }
    *remaining = remaining.checked_sub(granted - unused)
        .ok_or("tenant fuel accounting underflow")?;
    Ok(())
}

impl TenantRegistry {
    pub fn new(engine: Engine, module: Module, max_tenants: usize) -> Result<Self, Failure> {
        Self::with_memory_limit(engine, module, max_tenants, GUEST_MEMORY_BYTES)
    }

    // Debug-only guest execution: a small lifetime budget makes repeated
    // successful calls measurably exhaust the same finite Store quota.
    #[cfg(all(oreslang_debug_cargo_profile, debug_assertions, feature = "insecure-dev-caller-pin"))]
    pub fn new_for_fuel_conservation_smoke(engine: Engine, module: Module, max_tenants: usize) -> Result<Self, Failure> {
        Self::with_resource_limits(engine, module, max_tenants, GUEST_MEMORY_BYTES, 1_024)
    }

    // Debug-only regression: guest may grow to two pages but its Store is
    // restricted to one. Do not expose a custom Store cap in production.
    #[cfg(all(oreslang_debug_cargo_profile, debug_assertions, feature = "insecure-dev-caller-pin"))]
    pub fn new_for_growth_smoke(engine: Engine, module: Module, max_tenants: usize) -> Result<Self, Failure> {
        Self::with_memory_limit(engine, module, max_tenants, GUEST_MEMORY_BYTES / 2)
    }

    fn with_memory_limit(engine: Engine, module: Module, max_tenants: usize, memory_limit_bytes: usize) -> Result<Self, Failure> {
        Self::with_resource_limits(engine, module, max_tenants, memory_limit_bytes, MAX_FUEL)
    }

    fn with_resource_limits(engine: Engine, module: Module, max_tenants: usize, memory_limit_bytes: usize, initial_fuel: u64) -> Result<Self, Failure> {
        if initial_fuel == 0 || initial_fuel > MAX_FUEL {
            return Err("invalid initial tenant fuel".into());
        }
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
            initial_fuel,
        })
    }

    /// Canonical admission spelling for the existing bounded Wasmtime
    /// Store/Instance prototype. This is NOT a compiled actor VM proof.
    pub fn admit_tenant_vm(&mut self, id: &str) -> Result<TenantVMHandle, Failure> {
        self.admit(id)
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
        // profile forbids start sections. Each call gets no more than the
        // tenant's unspent lifetime balance; it never resets tenant fuel.
        store.set_fuel(self.initial_fuel)?;
        let instance = Instance::new(&mut store, &self.module, &[])?;
        // Preserve any instantiation charge instead of assigning fresh fuel.
        let remaining_fuel = store.get_fuel()?;
        let identity = Arc::new(());
        let handle = TenantHandle {
            id: id.to_string(),
            generation,
            identity: Arc::clone(&identity),
        };
        let durable = DurableLockQueues::new(generation, DurableQueueLimits::default())?;
        self.tenants.insert(id.to_string(), Tenant {
            generation,
            identity,
            phase: Phase::Running,
            store,
            instance,
            remaining_fuel,
            durable,
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
        // Validate before looking up a tenant; invalid host requests never
        // consume another tenant's quota.
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
            let granted = admitted_call_fuel(tenant.remaining_fuel, fuel)?;
            tenant.store.set_fuel(granted)?;
            let main = tenant.instance
                .get_typed_func::<(), i64>(&mut tenant.store, "main")?;
            let output = main.call(&mut tenant.store, ())?;
            let unused = tenant.store.get_fuel()?;
            debit_used_fuel(&mut tenant.remaining_fuel, granted, unused)?;
            Ok(output)
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
        tenant.durable.quiesce();
        tenant.phase = Phase::Quiescing;
        Ok(())
    }

    pub fn destroy(&mut self, handle: &TenantHandle) -> Result<(), Failure> {
        let tenant = self.checked_mut(handle)?;
        if tenant.phase != Phase::Quiescing {
            return Err("tenant must quiesce before destruction".into());
        }
        if !tenant.durable.drained() {
            return Err("tenant durable queue has unretired work".into());
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
    fn tenant_vm_alias_preserves_host_admission_signature() {
        let _admit: fn(&mut TenantRegistry, &str) -> Result<TenantVMHandle, Failure> =
            TenantRegistry::admit_tenant_vm;
        // Type/signature check only; this is not untrusted guest execution.
    }

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
    fn scheduler_calls_cannot_refill_logical_fuel() {
        let mut remaining = 1_000;
        for _ in 0..10 {
            let granted = admitted_call_fuel(remaining, 128).unwrap();
            debit_used_fuel(&mut remaining, granted, granted - 100).unwrap();
        }
        assert_eq!(remaining, 0);
        assert!(admitted_call_fuel(remaining, 128).is_err());
        assert!(admitted_call_fuel(128, 0).is_err());
        assert!(admitted_call_fuel(128, MAX_FUEL + 1).is_err());
        let mut other_tenant = 256;
        let granted = admitted_call_fuel(other_tenant, 128).unwrap();
        debit_used_fuel(&mut other_tenant, granted, 64).unwrap();
        assert_eq!(other_tenant, 192);
        assert_eq!(admitted_call_fuel(other_tenant, 512).unwrap(), 192);
        assert!(debit_used_fuel(&mut other_tenant, 64, 65).is_err());
        assert_eq!(other_tenant, 192);
    }

    #[test]
    fn invalid_fuel_debits_are_atomic_and_never_forge_credit() {
        let mut remaining = 9_u64;
        for (grant, unused) in [(0, 0), (1, 2), (10, 0), (u64::MAX, 0)] {
            assert!(debit_used_fuel(&mut remaining, grant, unused).is_err());
            assert_eq!(remaining, 9, "invalid debit changed the tenant balance");
        }
        let granted = admitted_call_fuel(remaining, 100).unwrap();
        assert_eq!(granted, 9, "request cannot mint more than lifetime balance");
        debit_used_fuel(&mut remaining, granted, 8).unwrap();
        assert_eq!(remaining, 8);
        debit_used_fuel(&mut remaining, 8, 0).unwrap();
        assert_eq!(remaining, 0);
        assert!(admitted_call_fuel(remaining, 1).is_err());
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
