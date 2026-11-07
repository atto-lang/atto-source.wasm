# Pooled Wasm actors with actor-owned managed host frames

**Status:** Proposed host/guest-call integration, stacked on Wasm PR #413. NOT compiled AttoLang managed call-frame lowering or independently verified guest parity.

## Source provenance

This branch ports fourteen exact Git blobs from source-local Wasm PR #160 head 040076fe579252606739f01a737833881c107b9c onto #413 head 02a1679a2b0f5b8ed36bd31f85ed0b9b42d1278d. No cross-organization source export or silent overwrite of old pooled PRs. It preserves the **newer #413 ActorArena** instead of importing the old arena implementation.

The canonical tests/fixtures/wasm32-single-source-actor.atto is byte-identical to its legacy .ores equivalent, Git blob adfc0b43463d7ce92d32a4b1b63602f91e527329. The two negative .ores fixtures are retained as explicit legacy compatibility tests.

## Runtime and lifecycle

- One private ActorArena per admitted pooled actor, and a separate independent guest WebAssembly.Instance/private two-page memory for each actor.
- The trusted Worker mints a physical actor turn and 16-byte managed logical bookkeeping frame around every synchronous native Wasm init, message, or teardown export. Validated i64 inputs/outputs are copied through that frame.
- Guest traps, invalid return types, or reentrant host calls cannot leave a resumable logical managed frame. Async results and unresolved Promise continuations are denied.
- The worker reports a host-only frame quiescence receipt; the pool validates exactly one frame per operation, zero outstanding logical frame bytes, and a true retirement bit after STOP. Missing, forged, or live-frame ACKs trigger carrier quarantine instead of success.
- On normal STOP, the worker first zeros the guest instance memory and retires actor-owned host memory, while existing host pool semantics fence generation and delay error settlement until real Worker termination.

This is trusted host bookkeeping evidence, not a cryptographic attestation, and not the actual engine stack or compiler-lowered AttoLang locals.

## Validation

New focus suites:
- tests/pooled-actor-frame-turn.test.mjs: 11 host-runtime regressions including canonical .atto byte pin, reentrancy, invalid/suspended-style async admission, cancellation/zeroization, and sibling actors.
- tests/pooled-managed-frame-worker.test.mjs: 3 hosted tests exercising real WebAssembly compiled from **synthetic LLVM IR** on one Worker, plus two intentionally forged ACKs; these ARE NOT compiled .atto guests.
- Previously authored source actor and ABI suites are ported unchanged except the canonical .atto source fixture and corresponding named verification test.

Commands, on exact source HEAD with Node 22/24 and Clang available:

    npm run test:managed-pooled-actors
    npm test

MANDATORY real source-compiler gate (must not skip):

    ORESLANG_LLVM_COMPILER=/approved/absolute/oreslang-llvmc ORESLANG_LLVM_COMPILER_SHA256=<verified-64-hex> npm run test:real-pooled-actors

The latter compiles the canonical .atto actor through real LLVM-to-Wasm, exercises 40 actors across two Workers with 25 messages each, checks STOP/restart and native frontend negative admission. Independently verify that pinned binary's source HEAD/tree. No source-org or external build run on this new HEAD is yet verified; steps=[] or steps=null denotes runner admission failure.

## Outstanding critical limitations

1. Actual guest locals, ownership roots, return frames, and continuation state are NOT lowered into actor-owned stack memory by the LLVM/Java/Wasm compiler here. The WebAssembly engine internal call stack is unchanged.
2. A guest trap or noncooperating loop currently quarantines the **entire shared carrier**, so same-Worker actor A overflow / actor B survival is NOT IMPLEMENTED. Different Workers can remain healthy; that is a weaker property.
3. These Node Workers do not establish an OS sandbox, zero host GC, strict AOT, actor supervisor CONTROL delivery or independent Java/LLVM language parity.
4. Keep draft until independent review, exact-head run/tree/fixture/compiler provenance, nonzero-step Node 22/24 tests and actual compiler-backed guest receipts.

## Next proof obligation

Introduce a compiler-owned bounded recursion/trampoline or checked guest managed-frame ABI in portable .atto source. Then execute one source actor A exhausting its bounded guest stack while co-located B continues, supervisor receives CONTROL, restart of A uses a new generation, and all old stack tickets/heap references are rejected. Validate on Java, LLVM, and Wasm independently.
