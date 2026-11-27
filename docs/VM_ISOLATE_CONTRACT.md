# OresVM / IsolateVM contract v0 (backend admission)

**Status: experimental host substrate.** Not full actor VM execution,
complete cross-backend parity, per-tenant physical resource enforcement or
a security sandbox. No general guest-code tenant isolation is claimed.

## Common vocabulary

- **OresVM:** root host, code registry, permission broker, global admission
  and tenant supervisor. It must not own tenant-writable guest module globals.
- **IsolateVM:** an OresVM-owned execution domain for one tenant incarnation;
  owns private mutable globals, heap/resource limits, actor registry and
  quiescence accounting. Reusing a tenant ID creates a new generation.
- **Actor:** individually scheduled concurrent unit inside exactly one
  tenant's IsolateVM, with sealed state, owned arena and mailbox.
- **Isolate execution context:** a versioned *borrowed entry capability*;
  never a raw writable pointer to the OresVM root or another tenant.

## Required lifecycle invariants

1. Created -> Running -> Quiescing -> Stopped -> destroyed.
2. Reject duplicate tenant IDs, unbounded admission, invalid quotas,
   stale/foreign/forged handles and actor ID replay after reincarnation.
3. Closing admission during quiescence must be atomic with new guest,
   actor, mailbox, callback and I/O registration accounting.
4. Complete shutdown only after guest calls and all actor,
   continuation, callback, mailbox-loan and I/O retirement have drained.
   Accounting is insufficient without physical OS/worker retirement.
5. Cross-isolate messages must be versioned and serialized or explicitly
   transferred by checked ownership. No borrowed raw pointers cross tenants.
6. A shared immutable AOT module may have different *tenant-owned*
   writable globals. Neither mutable module state nor user symbol identities
   silently become process global.
7. Include a distinct status/result ABI, including legitimate signed
   negative values. Check native artifact entry ABI **before** function
   pointer casts; ABI version mismatch must fail closed.
8. An in-process isolate is **not an OS security sandbox**. Native/FFI
   arbitrary pointers require process-level separation for hostile tenants.

## V8 lessons and crucial differences

V8 separates an isolate's engine/heap from its Context globals and supplies
host platform scheduling and explicit entry/handle scopes. Oreslang should
borrow explicit context ownership, generation-fenced handles, snapshots
for immutable initialization and fast tenant-specific state, **not**
the assumption that a V8 Isolate is equivalent to a renderer-process
security boundary. Oreslang must eventually schedule independently sealed
actors within one tenant concurrently, rather than imposing one
entering thread for the whole tenant. Pointer compression changes memory
representation, not authorization. In-process host admission is insufficient
for arbitrary untrusted native machine code.

Architecture reference: LLVM draft PR #1158,
`docs/ORESVM_VS_ISOLATEVM.md` in `oreslang-source.llvm`.

## WASM worker implementation

`src/tenant-vm.mjs` owns per-tenant identity, generation, worker quota and
life cycle. It *delegates* each admitted guest invocation to the existing
`runIsolatedCoreGuest`: immutable source-byte snapshots, no imports,
a fresh private Wasm instance in a disposable Node Worker, and termination
before resolving. This host does **not** create a new Wasm parser or a
second compilation pipeline. `npm test` includes
`tests/tenant-vm.test.mjs` with a real, import-free core Wasm fixture.
Quiescing closes new admission; completeShutdown waits for all worker
promises to settle after termination. Worker threads/V8 isolates are
not OS-process isolation and do not establish hard-real-time or strict AOT.
Tenant worker limits here are not a complete multi-process deployment quota.

## Real Worker memory-isolation regression (added)

`tests/tenant-worker-memory.test.mjs` runs a **real import-free core Wasm
module** via `OresVM.runGuest` and the repository's existing disposable
Worker pipeline. The fixture was compiled from a freestanding clang17 C
volatile static i64 counter, fixed 2-page linear memory and `main()->i64`.
Independent WebAssembly instances would return 1,2 if reused; each
disposable worker invocation must return 1. This is a **guest instance
memory freshness test**, not Oreslang source lowering, not durable actor
state, and not a proof that untrusted native/Wasm engine bugs are contained.

An invalid SHA-256 pin is additionally required to reject and release its
per-tenant/global worker lease only after underlying Worker termination,
so a neighboring tenant can continue. The original `tenant-vm.test.mjs`
checks identity-fenced handles, admission quotas and pending shutdown.
Exact-head `npm test` and real Worker/Node process logs are still
unverified. Hostile tenants still require an OS process sandbox.
