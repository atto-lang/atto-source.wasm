# Wasmtime tenant Stores: native experimental v0

**Canonical naming (2026-11-11): TenantVM** is the per-tenant runtime boundary. One Wasmtime Store/Instance per tenant is an experimental mechanism toward that goal; it does not alone prove full compiled multi-actor TenantVM security. See [TenantVM naming](TENANT_VM_NAMING_V1.md).

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
- Each tenant starts with a finite Wasmtime logical fuel budget (maximum 100
  million) that also covers instantiation. Per-call requested fuel is a positive
  **ceiling** on one invocation, not a refill: calls grant only the smaller
  of the requested limit and the tenant's remaining fuel and debit the actual
  consumed Wasmtime fuel after success. Resume/dispatch cannot mint fuel.
  An exhausted request or guest trap retires the Store/Instance rather than
  reusing mutable guest state.
  Both the tenant registry and the debug-only scalar runner explicitly enable
  Wasmtime `StoreLimitsBuilder::trap_on_grow_failure(true)`: denied resource
  growth must not silently return a `-1` sentinel that guest code could ignore.
  This is an intentional, potentially non-spec-compliant **host policy**.
  A direct `ResourceLimiter::memory_growing` Rust unit regression is included,
  but native tests must execute on a real runner before claiming runtime proof.
- Shutdown first fences new calls, then drops the tenant Store and Instance.
  The v0 synchronous `&mut self` registry serializes host operations; a
  future asynchronous broker must prove drain/termination before destroying
  in-flight tenant workloads.
- Tenant IDs are bounded ASCII identifiers, reject reserved dot-only
  components (`.` and `..`), and do not encode filesystem paths. The
  corresponding cross-backend reference contract is proposed in
  `oreslang-platform-conformance` PR #243. The `StoreLimits` budget is **not** a bound on total native RSS,
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
2. Duplicate/capacity admission fails, malformed tenant IDs reject, and
   quiescing rejects new execution. Two independent root registries deliberately
   reuse the same tenant string and numeric generation: cross-root handles,
   shutdown requests, and invalid fuel are rejected without damaging the
   legitimately owned compartment.
3. Destroying A invalidates its old handle; recreating the same tenant ID
   starts with a fresh counter of `1`.
4. Exhausting B's per-call fuel must trap and retire only B's Store.
   A distinct healthy tenant A remains running and continues from its prior
   counter state (`1` → `2` → `3`), while B's old handle is rejected for
   execution, shutdown and destruction. Fresh B starts with counter `1`
   without changing A's state.
5. All tenants are retired; a wrong AOT digest is refused before unsafe native
   deserialization.
6. The separate production-release runner remains fail-closed.

The companion `--tenant-memory-growth-smoke` runs a **real compiled guest**
built from C using `__builtin_wasm_memory_grow(0, 1)`. Its declared memory
starts at **one 64-KiB page** and allows growth to two pages. A Node control
executes four calls returning `1,2,3,4` and verifies that the memory really
grows from **64 KiB to 128 KiB**. Thus the module itself permits the growth.

The native Wasmtime AOT gate uses an explicitly **debug-only, insecure test
mode** that limits each tenant Store to **one page**, below the guest's
two-page declared maximum. `StoreLimitsBuilder::trap_on_grow_failure(true)`
must cause the fourth call to **trap because the Store denies it**, with an
actual memory-growth limiter error in the causal chain (not an unrelated
fuel/ABI trap). Only the offending Store may be retired; the healthy tenant
must continue `1 → 2 → 3`, the stale offender handle must be denied, and a
fresh offender must restart at `1`. The two Stores share a compiled Module
but not mutable guest memory. Wrong AOT digest rejection is also required.

**This does not relax production admission:** the precompiler still insists
on a private wasm32 memory with at most two initial pages and exactly a
two-page maximum; ordinary `TenantRegistry::new` still caps Stores at
128 KiB. The test-only lower cap is compiled into the debug + explicit
`insecure-dev-caller-pin` gate, and normal production/release AOT execution
remains disabled.

**Evidence boundary:** the Clang 17 / Node 22 guest-permitted-growth control
has been executed locally. The Wasmtime native AOT counterpart and Rust
limiter regression remain **NOT_EXECUTED** until a real source-organization
runner admits and executes the exact PR head. Tests of the source architecture
alone cannot certify actual guest trap/retirement behavior.

The negative-module corpus and AOT byte-tamper fixture are now generated by
`aot-host/precompile/src/bin/oreslang-aot-fixtures.rs`, a Rust executable
built with the pinned precompiler Cargo graph. It uses create-new file
publication for the six valid-WebAssembly negative/admission cases. On Unix,
AOT tamper testing rejects symlinks with `O_NOFOLLOW` and verifies the opened
file's device, inode, and size against the pre-open metadata; the smoke suite
also checks that a symlink's referent remains untouched. The tamper helper
requires exactly one hardlink both before and after opening a fixture to avoid
mutating a shared inode; a separate shell regression verifies this rejection.
Unsupported platforms fail closed instead of performing an unchecked mutation. The prior Python generator and inline
Python mutation were removed from the AOT smoke.

The shell smoke requires the pinned Rust toolchain, Clang/LLD and an executed
CI runner. Separately, `node --test tests/wasm-guest-store-isolation.test.mjs`
compiles the same counter fixture using Clang and runs a **real Node
WebAssembly.Module/Instance** guest without Cargo. Its five TAP checks cover
zero host imports / bounded exports, separate memory buffers and `1,1,2,2`,
rejection of growth beyond the per-instance two-page memory cap, and fresh
incarnation `1` while neighboring instances continue at `3`.
The committed test file (Git blob `ba7be4f40b4e3e9d1f0e675c54a8f50180e9fd9d`)
passed under local Node 22; this is a **guest fixture proof only**, not an
Oreslang-compiled guest or proof that Wasmtime's Rust Store registry or unsafe
AOT deserialization executed. **A zero-step GitHub Actions failure is NOT_EXECUTED, not a test
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
