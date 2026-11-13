# AttoLang actor-task parity — Wasm substrate (2026-11-12)

**Status: trusted Worker host lifecycle bookkeeping. NOT `.atto` task/await guest parity.**

`src/actor-task-lifecycle.mjs` supplies opaque per-ledger task identities, bounded slots, nested task cancellation, explicit STOP and physical-retirement state. `src/pooled-actor-worker.mjs` now seals the ledger and denies teardown if a future continuation bridge leaves any task outstanding. The Worker currently exposes only the existing fixed scalar actor ABI, and no task is admitted by a real guest compiler.

The ledger runs inside the carrier Worker; it is not a source interpreter, Promise-based stand-in for compiled `task {}`, or privilege for an external Future producer. A future compiler bridge must authenticate the *physical owning actor turn*, preserve non-reentrant state access, lower suspended frames in actor-owned linear memory, and deliver resumes via validated WAKE tickets. The host must never resume on ROOT/CONTROL or producer threads.

Test the current host substrate:

```sh
node --test tests/actor-task-lifecycle.test.mjs
node --test tests/pooled-actors.test.mjs
npm test
```

**Still required for parity:** positive and negative real `.atto` compiler tests, `suspends/await` lowering, structured child scopes, cross-actor concurrency and fairness, generation-fenced STOP/late-Future integration, and actual wasm32 guest execution with exact-head receipts. Zero-step or host-only tests cannot satisfy those gates. The current design supports managed host GC with isolated Wasm linear memory; it makes no process-wide zero-GC claim.

## Single-use WAKE replay fence (2026-11-12 update)

The ledger now refuses to `startOrResume` a suspended task. `suspend` returns a fresh opaque ledger-issued object per suspension. The trusted physical actor WAKE dispatcher must validate its carrier lease and Future source before invoking `resumeFromWake`; it consumes that exact ticket to transition back to running. Foreign tickets, wrong task, replay after resume, older tickets after a later suspension, and STOP are denied. The mutable single-writer lease remains checked. This is a *logical host replay guard*, not yet a compiler/physical-WAKE authority integration.

Exact committed Git blobs of the new host test:
- `src/actor-task-lifecycle.mjs`: `6e6060d3e6f2bf338c7dc1974d1f7596451cb1ef`
- `tests/actor-task-lifecycle.test.mjs`: `d0a640d65a9d6216b527e06f5c19c7c54fd8cd2d`

Local Node v22.16.0: `node --test tests/actor-task-lifecycle.test.mjs` **8/8 passed**, 0 failed; output SHA-256 `fb4d6d18167ae68ff25295ec9830380ed852db22a3eee47e9c1ee347d7752063`. Host-only exact blob evidence; no compiled `.atto` task/await guest or full `npm test` receipt exists. Source-org GitHub Actions jobs remain zero-step / NOT_EXECUTED.

## Audit and hardening receipt — 2026-11-12

Nested admission now requires the parent's **running** logical task stage. A suspended, ready, cancelled or settled parent cannot authorize a child task; caller physical turn authentication remains an external trusted-host requirement.

Exact branch source/test blobs:
- `src/actor-task-lifecycle.mjs`: `647baa4f6af4dc4f7d48f4c623e0451ad2ec9c22`
- `tests/actor-task-lifecycle.test.mjs`: `c99b55a7b415df950b5117bb12d067c30c8c7db3`

Executed on Node v22.16.0: **11 of 11 host-unit tests passed**. Twenty-five consecutive repetitions also passed (275 individual test executions). Output file SHA-256: `bfc9f44f1a45cd4653c2296ed0f93fd4c5b9921868fd3a4c30394a4cd17514db`. The new tests cover cross-actor independent running turns and a bounded nested graph whose STOP completion waits for all child cleanup. These are Node **host-only**, not Wasm guest/compiler proofs. The repository's private CI export policy lists **no approved destination or source snapshot**, so no cross-org code mirror is allowed.

## Two-phase physical suspension handshake (2026-11-13)

A source Task's call to `suspend(token)` now enters **`suspending`**, not `suspended`. The actor remains logically physically busy: no sibling mutable turn may run, no producer wake may resume it, STOP cleanup cannot retire it, and the actor's `isQuiescent()` stays false. Only the trusted carrier-turn exit path may call `confirmSuspendedTurnReturned(token,ticket)`, which consumes exactly one physical-turn receipt and transitions to `suspended`. A matching Future WAKE still must pass the separate single-use ticket check. Stale confirmation, duplicate confirmation, STOP racing the callback, and late producer wake fail closed.

**Scope caution:** `confirmSuspendedTurnReturned` is currently a method in a **host-side ledger**, not yet wired to a privileged Wasm Worker carrier callback. A guest with direct access could invoke it; do not expose this object as a guest API. Actual physical ownership verification and compiled `.atto` continuations are still missing.

Executed local Node v22.16.0 host-only receipts: exact code blob `4f0e1ded9c1cc6e88b3f23bcf75692e7599dbd15`; test blob `deded2019fc76b475b8e4ccb65f1be8a71872384`. **13/13 passed** in the baseline and **50 consecutive 13-test suites passed** (650 additional test passes, 663 total); full compiled wasm32 guest tests NOT_EXECUTED. Local receipt SHA-256 `c62c05b806a025c90d42c26f2c00553c6a827fe49aaf919e2315155ab37580e1`. Source-local GitHub Actions rerun `43333647776` was accepted but new job `131585229651` again recorded **0 executed steps**.
