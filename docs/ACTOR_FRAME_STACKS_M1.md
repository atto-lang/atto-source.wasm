# Actor-owned managed frame stacks (Wasm M1 host-runtime milestone)

**Status:** experimental host primitive only. NOT compiler-lowered actor execution, real native stack isolation, or Java/LLVM guest parity certification.

## Ownership and representation

- `ActorArena(actorId, incarnation)` retains its existing independent bounded two-page `WebAssembly.Memory` for actor heap/scratch bytes.
- `startStack(turn)` mints an opaque logical-execution authority and a fresh bounded, **non-shared** one-page `WebAssembly.Memory` for its managed frames. Multiple suspended logical executions use distinct backing memories; different actors and restarted incarnations never share frame handles or backing stores.
- Bootstrap quotas: up to **8 live logical stacks per actor**, **64 frames per stack**, **64 KiB frame bytes per stack** (maximum 512 KiB provisioned actor frame memory, in addition to the 128 KiB arena). These limits are host prototype limits, **not** a portable AttoLang frame layout or total process memory bound.
- `pushStackFrame`, `readStackFrame`, `writeStackFrame`, `popStackFrame` require the owning physical turn and active logical execution. Only the top frame is readable/mutable; frames are strictly LIFO. Handles/tokens are opaque object identities, never numeric offsets or raw WebAssembly.Memory references. Reads return copies, writes require exact-sized private Uint8Array data, and reuse scrubs bytes.
- `suspendStack(turn, execution)` retains managed frames while allowing `endTurn` to release the physical actor carrier. `resumeStack(nextTurn, ticket)` consumes one exact resume ticket and restores that logical execution, even after a different physical turn. No resume ticket is an actor-turn or heap capability. `endTurn` refuses to release a carrier while an execution is active.
- `finishStack` requires an empty frame chain; `cancelStack` also allows a suspended logical stack to be scrubbed and revoked without a resume. Actor `retire` closes all new access; outstanding external lifetime pins defer final byte scrub, after which all remaining stack memories and tickets are discarded.
- All stack allocation, token and frame operations are privileged host runtime APIs. No `.atto` guest code receives direct byte views, stack frame objects, or the host adapter. The implementation captures the new stack's Map/WeakMap/Array and Wasm Memory primitives before untrusted shared-realm mutation.

## Explicitly unsupported

1. A Wasm engine's internal call stack is **not** redirected into these memories. To gain real actor stack parity, compile `.atto` guest function locals, roots, return states and continuations into checked managed frame layouts. Bounded compiler recursion or a trampoline must prevent uninstrumented native Wasm stack overflow.
2. No real source `define actor` codegen, scheduler task wiring, authenticated ActorRef/messaging, `await` continuation save/restore, `select`, `handle_state` scoped critical access, or `rt borrow/take/share` frame-lifetime typechecking is added in this milestone.
3. A Node Worker provides a disposable execution carrier, **not** a dedicated actor-owned native stack, trusted guest sandbox, zero host GC, or Native AOT. Host WeakMaps, tokens, frames and runtime live in managed JS. Native Wasm memory may remain allocated until the host engine collects it.
4. Stack quota failures are checked host exceptions; a compiler must map them into the canonical uncatchable stack-containment/supervisor CONTROL path without allowing guest catch/trap to suppress them. That path is not wired yet.
5. This PR is not evidence that LLVM, Java/GraalVM, Wasmtime or `.atto` guest actor conformance has executed. Do not merge on host-only checks.

## Required next gates, smallest first

1. **Run exact-PR-head Node host regressions:** `node --test tests/actor-frame-stacks.test.mjs tests/actor-frame-stack-primordials.test.mjs tests/actor-arena.test.mjs` with executed job steps and captured source head/tree SHA. A zero-step GitHub job is NOT_EXECUTED.
2. **Wire the actual pooled actor runtime:** one actor arena per live incarnation; scheduler-owned physical turn and task identity; explicit save/restore across suspension and cancellation; STOP + supervisor CONTROL quiescence; healthy actor B survives actor A stack quota failure on the same worker pool.
3. **Compiler and guest:** pin the actual LLVM frontend/compiler SHA and canonical `.atto` fixtures; lower actor-owned typed frames and checked recursion to real Wasm32 guest code. Prove independent actors A/B use distinct linear-memory domains and isolated managed frame roots, plus a bounded A overflow with B success and supervisor notification.
4. **Backend conformance:** execute matching Java/LLVM/Wasm guest traces at exact PR heads with contract hashes, audit ownership, null/stale generations, non-LIFO and cross-execution misuse, quotas, await/resume, cancellation and restart.
5. **AOT and hostile guests:** native Wasmtime AOT, fuel/epoch exhaustion, process sandboxing for untrusted tenants, resource quotas, physical worker-exit receipts and memory quiescence evidence. No unapproved private-source export.

## Related work

- Java actor frame storage [#2627](https://github.com/ores-truffle-oreslang/oreslang-source.java/pull/2627), source-task retention [#2631](https://github.com/ores-truffle-oreslang/oreslang-source.java/pull/2631), compiled frame integration [#2638](https://github.com/ores-truffle-oreslang/oreslang-source.java/pull/2638).
- LLVM bounded scalar stack containment [#1350](https://github.com/ores-truffle-oreslang/oreslang-source.llvm/pull/1350) and actor-owned heap lowerings are separate gates.
- Wasm current-main private actor heap/guest bridge [#120](https://github.com/ores-truffle-oreslang/oreslang-source.wasm/pull/120) and pooled real source actors [#160](https://github.com/ores-truffle-oreslang/oreslang-source.wasm/pull/160) remain draft/integration work. This source-branch addition does **not** merge or silently certify those branches.

The default `npm test` discovers these regression files; it is not a substitute for real guest and native AOT execution.
