# TenantVM — canonical runtime terminology (2026-11-11)

**Decision:** Call the per-tenant runtime and security compartment **TenantVM** in AttoLang documentation, specifications, roadmaps, conformance matrices, and all toolchains. `IsolateVM`, `tenant isolate`, `tenant VM-isolate`, and `TenantVm` in historical identifiers all refer to the **TenantVM concept**, not to different architectural layers. Preserve exact existing code symbols and versioned schemas until separately tested compatibility migrations; no implicit ABI or serialization rename.

## Canonical hierarchy

```text
OS process
  OresVM                  trusted root host, broker, code registry, fair scheduler
    TenantVM(tenant A, generation N)
      private tenant memory/state, grants, symbol scope, actor registry, limits
      actor A1             sealed state + own heap/arena + mailbox + turn
      actor A2             sealed state + own heap/arena + mailbox + turn
    TenantVM(tenant B, generation M)
      actor B1             separate tenant, private actor resources
```

- **OresVM:** trusted process-root authority, budgets, immutable code caches, per-tenant fair admission, lifecycle supervision and capability-mediated I/O. It must not hold user-writable globals for multiple tenants as if they were one tenant.
- **TenantVM:** exactly one authenticated tenant **incarnation** (ID + generation + opaque host-issued authority). Owns tenant mutable module/global state, per-tenant permissions and quotas, actor registry, execution/failure boundary, scheduler allocation and teardown. Many actors may reside in one TenantVM.
- **Actor:** one scheduled unit inside exactly one TenantVM. Owns private sealed state, actor heap/arena, mailbox and checked execution turns; parallel actor work must obey sealed-state and critical-read/critical-write rules. Actor heaps/locks alone do not create a TenantVM security sandbox.
- **TenantVM handle:** host-issued and checked against owning OresVM and generation. Never grant authority on a tenant name string, reconstructed ActorRef, raw address, or guest-provided label.

## Required behavior (target, NOT current implementation certification)

1. An untrusted actor must enter only a **verified** TenantVM boundary with validated guest code, enforced private memory/CPU/resource caps and independent termination. If unavailable, the backend **fails closed**, without downgrading to a plain Context, in-process native callback, worker, or shared CLR heap.
2. Distinct tenant generations never share writable module state, user symbols, capabilities, allocation grants, mutable buffers, mailboxes or actor references. Immutable approved compiled code may be shared.
3. Inside a TenantVM, independent actors may execute concurrently, while actor state remains sealed and free of unsynchronized concurrent writes. Non-reentrant scalar turns cannot overlap. Host root scheduling must be fair **per tenant**, not let tenants with more actors starve others.
4. Direct cross-tenant actor references and borrowed pointers fail. Any cross-tenant message must pass an explicitly trusted, generation-fenced, capability-checked serialization/ownership broker; charge producer, destination and host aggregate quotas.
5. Quiescence seals new admission, resource pins drain before teardown, and restart mints a new generation. One tenant's trap, OOM or stop must not compromise a neighbor.
6. The *same OS process* may hold multiple TenantVMs. A process sandbox is optional defense in depth; neither the word `TenantVM` nor an actor arena implies physical isolation. A runtime/validator/compiler bug can still compromise multiple tenants in one process.

## Naming and compatibility

| Concept | New canonical spelling | Historical names retained in code or documents |
| --- | --- | --- |
| Root host | `OresVM` | `OresVmHost` (specific .NET class) |
| Per-tenant VM | **`TenantVM`** | `IsolateVM`, `tenant isolate`, `TenantVm`, `TenantIsolateManager` |
| VM identity | `TenantVMHandle` (target API vocabulary) | `IsolateHandle`, `TenantHandle` |
| VM policy | `TenantVMPolicy` (target API vocabulary) | `IsolatePolicy`, backend-specific isolation modes |
| Actor scope | `Actor` / `ActorRef` | Existing actor tickets and backend handles |

`TenantVM` is **not a new AttoLang keyword**; source-level function/method names stay `snake_case`. When creating a public type, use `TenantVM` if the target language permits it. Do not change existing exported types, paths, generated symbols, C ABI structs, wire tags, manifest IDs, flags, tests or API names merely to satisfy a documentation rename. Introduce aliases/adapters only after compiling and running consumers; removal of legacy spellings requires an explicit deprecation cycle.

## Conformance and evidence

Canonical architecture: [tenant isolation v2](https://github.com/ores-truffle-oreslang/oreslang-platform-conformance/blob/main/docs/TENANT_ISOLATION_V2_SHARED_PROCESS.md). Test actual two-tenant compiled actor guests, stale/forged grants, per-actor and aggregate caps, CPU/fuel/deadline cancellation, heap violation, restart, IO/loan retirement, and neighbor survival. Label source-only models as `SOURCE_FREE_REFERENCE`, host-only evidence as such, and unexecuted backend tests as `NOT_EXECUTED`. GitHub Actions jobs with **zero steps** do not certify anything. No private source mirroring without existing independent security approval.

## Backend-specific interpretation

**Wasm/Wasmtime:** A `TenantVM` is the tenant's execution domain, implemented toward one bounded `Store` with validated Wasm `Instance`(s) and tenant-private state. The current `TenantRegistry` is a scalar host substrate, not compiled AttoLang multi-actor containment or independently proven kill. Browser or Node Workers are not interchangeable with Wasmtime Stores or proof of hostile-JS containment.
