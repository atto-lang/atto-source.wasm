# Checked recursive Wasm actor v1 — same-carrier bounded terminal-fault integration

**Status:** Implementation and tests committed on a draft stacked branch. Exact-head Node/Clang/LLVM compiler-backed **NOT_EXECUTED** until trusted source-org runner admission recovers. The generic AttoLang recursive actor language, supervisor CONTROL and multi-backend parity remain unverified.

## Dependency

LLVM [#1551](https://github.com/ores-truffle-oreslang/oreslang-source.llvm/pull/1551) extends [#1546](https://github.com/ores-truffle-oreslang/oreslang-source.llvm/pull/1546) with a strict opt-in `--experimental-wasm-actor-recursion-v1` compiler emitter. Canonical `contracts/actor-stack-containment-v1/recursive-sibling.atto` is byte-identical to LLVM's checked-recursion fixture, Git blob `947781cddf09d8e3e08c51cff2b7d8960e2d4750`.

The only admitted recursive source helper is `fnc descend(int n): int { return n == 0 ? 0 : 1 + descend(n - 1); }`, called by one synchronous actor `on_message(int)` with a private initial-zero field and pure constant main. LLVM codegen emits an **iterative** 64-frame stack machine with no native/engine recursive call for this exact shape. All other recursive helper forms, effects, imports and async/suspension remain unsupported.

## Two distinct frame domains

1. The compiled actor's private WebAssembly.Instance linear memory contains `[64 x i64]` guest source frames, depth, lifecycle, and typed terminal status. `on_message(63)` occupies 64 frames and returns i64 63. `on_message(64)` rejects **the 65th** push before any unsafe GEP, scrubs the guest stack, sets terminal i32 status=1 and lifecycle TERMINAL, then traps with Wasm `unreachable`. At `-Oz` the stores and status read are volatile so the native optimizer must not drop them before a noreturn trap. Negative input is rejected without being mislabeled stack quota.
2. The trusted pooled Worker still has the separate host `ActorArena` logical 16-byte bookkeeping frame for each actual synchronous guest export. It must unwind before any actor ACK/fault. A guest Wasm trap cannot leave a live host stack or borrow/pin behind.

The exact typed **five-export ABI** adds `oreslang_wasm_actor_frame_status():i32` to legacy init/i64-handle/teardown/private-memory. Both the host's parent admission and Worker's `assertScalarActorAbi` check exact signatures, export count, two-page fixed memory and zero imports. Legacy four-export scalar actor remains valid and may return ordinary i64 `75` without triggering a stack failure.

On a genuine `WebAssembly.RuntimeError("unreachable")` the Worker reads the status export. Only status=1 on the checked profile yields `STACK_BUDGET_EXHAUSTED_V1`. It revokes actor identity, verifies all host frames and pins are zero, zeros its own guest linear memory, retires the actor-owned host arena, and emits a typed actor-fault quiescence receipt. The host independently validates the active ticket/incarnation, exact known fault code, zero frame bytes, and `retired=true`; it rejects every queued message and STOP for A, but continues executing unrelated B on the **same Worker**.

Unknown traps, invalid status, i64 returned with status1, mismatched ABI, forged receipt or failed cleanup are still **whole-carrier fatal**. This opt-in does not make untrusted arbitrary Wasm safe or prove Node Workers are OS sandboxes.

## Test/evidence layers

Source/host subset (available to ordinary Node 22 + Clang, but not yet verified as running on the current head):

- `tests/checked-recursive-actor-v1.test.mjs` pins the shared canonical `.atto` Git blob; checks that a Clang-compiled synthetic core-Wasm status ABI fails admission without opt-in and rejects an i64-instead-of-i32 status export. Also rejects ordinary return with terminal status=1 and forged incomplete typed actor-fault receipts.
- `tests/actor-stack-containment-proposal.test.mjs` pins nine proposed behavioral scenarios; all remain `NOT_EXECUTED` until actual conformance receipts exist.

Mandatory *real compiler* gate (not synthetic IR, not JS interpreter):

```bash
ATTO_REQUIRE_REAL_ACTOR_RECURSION=1 \
ORESLANG_LLVM_COMPILER=/approved/absolute/oreslang-llvmc \
ORESLANG_LLVM_COMPILER_SHA256=<independently-approved-sha256> \
ORESLANG_LLVM_SOURCE_SHA=<independently-verified-LLVM-PR1551-head> \
ORESLANG_LLVM_SOURCE_TREE_SHA=<independently-verified-LLVM-PR1551-tree> \
node --test tests/checked-recursive-actor-v1.test.mjs
```

Or run `npm run test:real-wasm-actor-recursion` with the four `ORESLANG_LLVM_*` variables set.

The real-gate test compiles the **unchanged .atto** source via an exact-binary immutable compiler snapshot and Clang wasm32, verifies binary import-free five-export ABI and IR/Wasm SHA-256, then launches A and B **on a single PooledWasmActors Worker**. It proves 64 frames, 65th terminal error, queued DATA and STOP rejection, B still healthy, stale actor A handle denied and fresh independent replacement actor. It separately compiles legacy four-export actor, runs normal i64 `75`, and rejects an altered recursive helper without publishing binary bytes.

**No real compiler-backed guest receipt exists on this head yet.** An executable binary hash is byte identity, not proof of which LLVM source head built it; the source HEAD/tree and approved binary build chain require independent attestation. Zero-step Actions results are runner-admission failures, not implementation test failures.

## Unimplemented/held responsibilities

- This is a **single AST-certified recursive scalar helper recurrence**, not arbitrary direct/mutual/indirect recursive functions, class methods, actor-owned continuation PCs, borrow/owned reference roots, suspension or TCO.
- Manual fresh actor spawning is not an authoritative supervisor restart. The nine-case manifest's `SUPERVISOR-CONTROL`, `A-STALE-RESUME` and independent Java/LLVM/Wasm traces remain **NOT_EXECUTED**.
- The same-Worker B-survival acceptance is authored in the real guest test but unverified. Stack quota isolation on unsupported general Wasm guest shapes remains carrier-fatal.
- Keep this PR **DRAFT** until ORESoftware independent review, approved binary-source proof, source-org nonzero CI steps, and independently executed real native LLVM/Wasm guest acceptance. Organization Actions currently suffers provider-reported payment/spend-limit pre-job refusal; only an authorized billing owner should resolve the confirmed condition. No private-source cross-organization transfer or governance bypass.
