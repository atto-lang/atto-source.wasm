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

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Running,
    Quiescing,
}

// A Store's set_fuel() resets its slice on every invocation. Keep a second
// host-owned lifetime ledger so a cooperative actor cannot replenish its
// immutable per-incarnation execution quota by yielding/reentering.
#[derive(Debug)]
struct LifetimeFuelBudget {
    remaining: u64,
}
impl LifetimeFuelBudget {
    fn from_instantiated_store(remaining: u64) -> Self {
        Self { remaining }
    }
    fn grant(&self, requested: u64) -> Result<u64, Failure> {
        if !(1..=MAX_FUEL).contains(&requested) {
            return Err("tenant fuel outside admission bounds".into());
        }
        let authorized = requested.min(self.remaining);
        if authorized == 0 {
            return Err("tenant lifetime execution fuel exhausted".into());
        }
        Ok(authorized)
    }
    fn charge(&mut self, authorized: u64, unspent: u64) -> Result<(), Failure> {
        if authorized == 0 || unspent > authorized {
            return Err("invalid Wasmtime fuel accounting".into());
        }
        self.remaining = self.remaining.checked_sub(authorized - unspent)
            .ok_or("tenant lifetime fuel ledger underflow")?;
        Ok(())
    }
}

struct Tenant {
    generation: u64,
    identity: Arc<()>,
    phase: Phase,
    store: Store<StoreLimits>,
    instance: Instance,
    lifetime_fuel: LifetimeFuelBudget,
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
    // Trusted host admission ceiling. Production uses MAX_FUEL. The
    // insecure debug smoke may lower it to exercise exhaustion quickly.
    lifetime_fuel_limit: u64,
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
        Self::with_limits(engine, module, max_tenants, GUEST_MEMORY_BYTES, MAX_FUEL)
    }

    // Debug-only regression: guest may grow to two pages but its Store is
    // restricted to one. Do not expose a custom Store cap in production.
    #[cfg(all(oreslang_debug_cargo_profile, debug_assertions, feature = "insecure-dev-caller-pin"))]
    pub fn new_for_growth_smoke(engine: Engine, module: Module, max_tenants: usize) -> Result<Self, Failure> {
        Self::with_limits(engine, module, max_tenants, GUEST_MEMORY_BYTES / 2, MAX_FUEL)
    }

    // Small lifetime fuel is deliberately accessible ONLY to the insecure
    // test binary. It still drives actual Wasmtime compiled guest code.
    #[cfg(all(oreslang_debug_cargo_profile, debug_assertions, feature = "insecure-dev-caller-pin"))]
    pub fn new_for_fuel_lifetime_smoke(
        engine: Engine, module: Module, max_tenants: usize
    ) -> Result<Self, Failure> {
        Self::with_limits(engine, module, max_tenants, GUEST_MEMORY_BYTES, 512)
    }

    fn with_limits(
        engine: Engine, module: Module, max_tenants: usize,
        memory_limit_bytes: usize, lifetime_fuel_limit: u64
    ) -> Result<Self, Failure> {
        if !(1..=MAX_TENANTS).contains(&max_tenants) {
            return Err("invalid tenant admission capacity".into());
        }
        if memory_limit_bytes != GUEST_MEMORY_BYTES && memory_limit_bytes != GUEST_MEMORY_BYTES / 2 {
            return Err("invalid tenant memory limit".into());
        }
        if !(1..=MAX_FUEL).contains(&lifetime_fuel_limit) {
            return Err("invalid tenant lifetime fuel limit".into());
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
            lifetime_fuel_limit,
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
        // Instantiation consumes from the SAME lifetime quota. Per-invoke
        // slice replacement below may not replenish this aggregate.
        store.set_fuel(self.lifetime_fuel_limit)?;
        let instance = Instance::new(&mut store, &self.module, &[])?;
        let lifetime_fuel =
            LifetimeFuelBudget::from_instantiated_store(store.get_fuel()?);
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
            lifetime_fuel,
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
        if !(1..=MAX_FUEL).contains(&fuel) {
            return Err("tenant fuel outside admission bounds".into());
        }
        let tenant = self.checked_mut(handle)?;
        if tenant.phase != Phase::Running {
            return Err("tenant is quiescing".into());
        }
        // All errors after the host has authorized an execution attempt
        // must pass through one cleanup path, including exhausted lifetime
        // fuel, inconsistent Store accounting and Wasmtime traps.
        let outcome = (|| -> Result<i64, Failure> {
            let authorized = tenant.lifetime_fuel.grant(fuel)?;
            tenant.store.set_fuel(authorized)?;
            let main = tenant.instance
                .get_typed_func::<(), i64>(&mut tenant.store, "main")?;
            let answer = main.call(&mut tenant.store, ())?;
            tenant.lifetime_fuel.charge(authorized, tenant.store.get_fuel()?)?;
            Ok(answer)
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
    fn hard_fuel_is_never_replenished_by_successful_dispatches() {
        let mut lifetime = LifetimeFuelBudget::from_instantiated_store(512);
        for _ in 0..4 {
            let grant = lifetime.grant(128).unwrap();
            assert_eq!(grant, 128);
            lifetime.charge(grant, 0).unwrap();
        }
        assert_eq!(lifetime.remaining, 0);
        assert!(lifetime.grant(128).is_err(),
            "new invoke must not renew exhausted incarnation fuel");

        let mut partial = LifetimeFuelBudget::from_instantiated_store(512);
        let first = partial.grant(128).unwrap();
        partial.charge(first, 127).unwrap();
        assert_eq!(partial.remaining, 511);
        let last = partial.grant(512).unwrap();
        assert_eq!(last, 511, "slice must be capped by total remaining");
        partial.charge(last, 0).unwrap();
        assert!(partial.grant(1).is_err());

        let sibling = LifetimeFuelBudget::from_instantiated_store(512);
        assert_eq!(sibling.grant(512).unwrap(), 512,
            "one tenant's quota must never drain a sibling incarnation");
    }

    #[test]
    fn fuel_ledger_rejects_untrusted_or_inconsistent_accounting() {
        let mut ledger = LifetimeFuelBudget::from_instantiated_store(128);
        assert!(ledger.grant(0).is_err());
        assert!(ledger.grant(MAX_FUEL + 1).is_err());
        assert!(ledger.charge(128, 129).is_err());
        assert!(ledger.charge(0, 0).is_err());
        assert_eq!(ledger.remaining, 128);
        ledger.charge(128, 0).unwrap();
        assert_eq!(ledger.remaining, 0);
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
