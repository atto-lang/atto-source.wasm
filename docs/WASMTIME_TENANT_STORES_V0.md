# Wasmtime tenant Stores: native experimental v0

## Decision

In the native `oreslang-source.wasm` host, a **tenant isolation domain**
is one Wasmtime `Store<StoreLimits>` containing **one** core Wasm
`Instance` with its own private linear memory. The `Engine` and compiled
`Module` may be shared across tenants to avoid recompilation; they are not
tenant-owned mutable guest data. The public design name may be "tenant isolate,"
but **Wasmtime does not expose a V8-style `Isolate` API**. The concrete
boundary used here is a separate `Store` and `Instance`.

This is an in-process **Wasm execution and linear-memory boundary**, not an
independent OS process, KVM domain, native runtime heap, or protection against
compromise of the Rust host or Wasmtime's native code.

## Implementation

- `aot-host/run/src/tenant_isolation.rs` implements a bounded native
  `TenantRegistry`. It owns a unique Store + Instance per tenant.
- Two tenant handles never provide direct access to each other's Wasmtime
  memory, globals, or tables. The Rust embedding does not expose host imports.
- Opaque Rust `Arc` identity and monotonic generations fence stale and forged
  in-process handles. External users must still authenticate to the broker;
  an arbitrary tenant-id string alone is not authority.
- Admission is limited to 32 tenants **per registry**, 128 KiB guest linear
  memory, one memory, one instance, and zero tables per Store.
- Calls reset a strictly positive fuel budget (maximum 100 million), and a
  guest trap retires the Store/Instance rather than reusing mutable guest state.
- Shutdown first fences new calls, then drops the tenant Store and Instance.
  The v0 synchronous `&mut self` registry serializes host operations; a
  future asynchronous broker must prove drain/termination before destroying
  in-flight tenant workloads.
- Tenant IDs are bounded ASCII identifiers and do not encode filesystem
  paths. The `StoreLimits` budget is **not** a bound on total native RSS,
  compiler memory, host heap, or CPU wall time.

## Authentication and deployment gates

The existing native AOT runner intentionally **refuses production execution**.
The debug-only `insecure-dev-caller-pin` feature is not a signature or secure
artifact authorization. Native `.cwasm` deserialization is `unsafe`: never
feed it attacker-supplied bytes or a hash supplied by the same attacker.

A production tenant service requires independently authenticated artifact
approval, matching Wasmtime/CPU/config provenance, an independently supervised
OS process (or microVM/gVisor boundary for hostile tenants), OS/cgroup RSS and
CPU controls, bounded code-cache and compilation concurrency, aggregate
multi-process tenant quotas, kill/interrupt behavior, and an approved
capability/I/O ABI. None is implemented by the v0 registry.

The current guest ABI remains **only** `main: () -> i64`, zero imports,
bounded private `wasm32` linear memory. Tenant stores do not establish actor
state/ownership, async scheduling, mailbox QoS, source actor lowering, or
WASI/component support.

## Real regression gate

`aot-host/tests/smoke.sh` generates an import-free LLVM wasm32 module whose
`main` increments a private memory counter. The existing trusted precompiler
produces a pin-checked Wasmtime AOT module. The debug runner's
`--tenant-isolation-smoke` path then asserts:

1. Tenant A and B return `1,1,2,2` in interleaved calls using one shared
   compiled Module but two independent native Wasmtime Stores.
2. Duplicate/capacity admission fails and quiescing rejects new execution.
3. Destroying A invalidates its old handle; recreating the same tenant ID
   starts with a fresh counter of `1`.
4. Exhausting B's per-call fuel must trap and retire its entire Store. The old
   handle must fail, and a fresh B incarnation must start with a counter of `1`.
5. All tenants are retired; a wrong AOT digest is refused before unsafe native
   deserialization.
6. The separate production-release runner remains fail-closed.

The shell smoke requires the pinned Rust toolchain, Clang/LLD and an executed
CI runner. **A zero-step GitHub Actions failure is NOT_EXECUTED, not a test
pass or an implementation failure.** A passing smoke demonstrates native
Wasm memory separation, not malicious-host containment.

For browser execution, retain the separate Node Worker host but **do not**
describe it as Wasmtime tenant security or an OS sandbox.

## Next hardening milestones

- Integrate an authenticated operator-owned tenant broker and a separate
  OS process/security domain for mutually hostile tenants.
- Make durable tenant state and actor-mailbox lifetimes explicit. Multiple
  actors inside one tenant share its security domain; actor-owned arenas are
  still required.
- Add live fuel/trap teardown, fault injection, sustained RSS pressure,
  quota race, epoch/cancellation, forged broker identity and native crash
  tests on an exact source commit with a real, stepful CI run.
- Preserve strict AOT-only production execution and backend-independent
  ownership/capability checks; do not silently fall back to V8 Worker threads.
