# Pooled Wasm actor-owned frame bridge — M1

**Status:** trusted-host prototype; **not AttoLang guest stack lowering**, true native stack isolation, host zero-GC, or certified Java/LLVM parity.

## Current execution path

`PooledWasmActors` from source-actor integration draft #160 remains a fixed-size trusted pool of Node Workers. Each admitted module is instantiated with its **own** fixed, bounded two-page exported Wasm linear memory and **zero guest imports**. It does not gain host callbacks, WASI, or shared memory.

This change adds `src/actor-frame-ledger.mjs`. Each resident actor incarnation owns a separate `ActorFrameLedger` inside the very same Worker as its guest instance. During `init`, `on_message(i64)` and `teardown`, the Worker explicitly reserves one logical turn, one execution and a 16-byte scalar input/output frame. It releases the frame and physical turn before posting an ACK. If the call traps or frame admission fails, the Worker reports a fatal result. The host's existing carrier-quarantine protocol remains responsible for awaiting physical Worker exit before reclaiming actor authority.

Each logical execution has an independent non-shared, one-page `WebAssembly.Memory`, allocated lazily and zeroized on frame removal, cancellation and actor retirement. Reuse is **only within the same actor incarnation** and cannot revive opaque frame capabilities. Up to 8 simultaneously suspended executions, 64 live frames and 64 KiB per execution are allowed (512 KiB of actor-managed frame backing at the upper limit). Actual pooled guest calls are **synchronous**, never suspended by this bridge. Suspension/resume operations are host primitives reserved for a future compiler/scheduler integration.

The actor's guest-exported memory and the frame-ledger memory are **different** backing objects. No guest memory import or guest API references the managed ledger. This is a host-owned spill/record boundary, not a claim that current guest locals, return addresses or execution roots live in actor-owned frames. The engine's native Wasm stack remains separate and can still overflow; unbounded recursion is not made safe by this bridge. The heap arena in Wasm #412 is another host prototype and must be reconciled rather than wholesale-overwritten onto #160.

## Security invariants

- Actor incarnation: actor ID plus host-issued 128-bit hexadecimal incarnation identity; no foreign or prior incarnation can use this ledger's opaque turn/execution/frame/ticket objects.
- Exclusive physical turn, checked LIFO top-frame access, bounded byte/depth/execution quotas.
- Owned-copy reads; exact-size non-shared Uint8Array writes; native typed-array internal-slot checks.
- Strict active/suspended state transitions; one-use tickets, cancellation revoke and STOP scrub. Stopped ledger does not admit any new turn.
- Capture Map, WeakMap, TypedArray, WebAssembly.Memory and Array core methods before shared-realm modification.
- No native worker/process isolation of untrusted tenants; the existing trusted-only admission and worker failure domain remain unchanged.

## Test and evidence classification

`tests/pooled-actor-frame-bridge.test.mjs` contains 10 authored Node tests: nine ledger/lifecycle/security cases, and one executable synthetic LLVM IR -> Clang -> actual pooled Wasm Worker fixture. In the latter, actor A and actor B share a Worker, get independent state, STOP one without killing the other, then create an isolated replacement. **This test must actually execute on an approved source runner before the behavior is certified.**

During authoring, a V8 JavaScript syntax parse succeeded for all three JS files, and eight ledger test bodies passed against a fake `WebAssembly.Memory` model. The detached-buffer test, Node worker invocation, Clang-built guest, canonical `.atto` compiler, full `npm test`, Wasmtime and AOT were **NOT_EXECUTED**. Do not present host-model checks as guest parity.

Required exact-head gate (nonzero runner steps):

```sh
node --test tests/pooled-actor-frame-bridge.test.mjs tests/pooled-actors.test.mjs
npm test
```

Record PR head SHA, tree SHA and test/worker/runtime blob hashes. A failed GitHub job with zero executed steps is **NOT_EXECUTED**, not a runtime failure or success. Do not transfer private source to alternate organizations without independent source-policy approval and allowlist entries.

## Next implementation steps

1. Reconcile the original `ActorArena` host heap hardening in #160 and frame-stack prototype in #412 into one reviewed, actor-incarnation memory owner; do not discard transactional allocator/prototype fixes from #160 or guest-instance binding invariants from #120.
2. Extend the compiler's real wasm32 actor ABI to declare typed frame sizes, roots, return states and explicit suspension points. Enforce checked recursion or trampolining *before* a Wasm engine stack overflow.
3. Integrate `await`, `select`, pinned borrow frames, sealed state and supervisor CONTROL leases with generation-scoped task identity. A scheduler must never grant a new physical turn to an active unsuspended execution.
4. Verify canonical `.atto` actor A stack-budget failure with surviving actor B, supervisor notice, STOP/restart, stale-ticket denial and no memory aliasing on the same and different workers. Run matching Java/GraalVM and LLVM executed-guest fixtures and native Wasmtime AOT.
5. Obtain independent review, an authorized runner and exact-head execution evidence. Keep the integration draft; no merges or protected-main policy bypasses are implied.

**Dependency:** This patch is stacked on Wasm PR #160 (`040076fe579252606739f01a737833881c107b9c`), which itself depends on #154 -> #151. It does not modify or merge any of those branches.
