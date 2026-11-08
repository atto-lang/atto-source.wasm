# Amortized untrusted actor checkpoints — v1 (wasm)

## Contract

- Default slow-poll interval: **128 completed guest reductions**. The instrumented hot path uses a small integer countdown and a predictable branch; 64-bit aggregate accounting occurs only on the 128th reduction. A clock read, scheduler inspection, cancellation delivery, or runtime FFI is never performed on every iteration.
- A 512-backedge value is a *fairness handoff target*, not the hard tenant execution quota. After 512, slow polls remain at 128-edge boundaries; do not change to a slow poll on every overdue iteration. A separate safe critical-section exit may request one immediate poll.
- Replenishing a fairness slice must **never replenish hard tenant fuel**. Counter overflow saturates total accounting without disabling the independent window counter.
- Only committed backedges and compiler-verified call sites count. Untrusted source cannot mutate or bypass compiler-private counter state. Optimizer/codegen must retain checkpoint coverage; uninstrumented loop/cycle admission must fail closed.
- A slow poll may arrange resumable cooperation ONLY after the compiler proves a heap-resumable continuation, ownership-safe post-commit state, and absence of live critical/no-suspend loans. Otherwise use a defined trap/terminate path, never fake suspension of a native stack.
- Non-terminating imported/native/FFI work requires a separate isolate/process watchdog. A cooperative poll cannot make arbitrary native execution safe.

## Current backend status (2026-11-07)

Wasmtime hard fuel stays mandatory and separately tested per Store. Rust host quantum uses a 128-tick countdown with saturation and million-tick regressions. Guest wasm32 checkpoint instrumentation is NOT yet implemented; production AOT tenant execution remains fail-closed absent authenticated artifact provenance and OS isolation.

## Missing compiler-backed gate

Add bounded guest backedge instrumentation before wasm32 binary emission, keep fuel enabled, and run actual Wasmtime infinite-loop and critical no-yield fixtures.

Acceptance: a pinned exact-head test run must execute real guest loops, recursion, cancellation, critical sections, 127/128/129/511/512/513 boundaries, overflow/saturation, tenant coexistence, and negative mutations where removing a checkpoint causes admission failure. Source-free or host-only tests are not guest execution evidence; steps=null/[] is runner admission failure, not a test pass or failure.


## Hard fuel and actor reincarnation ledger (P0)

The AOT debug-only tenant Store now has **two** budgets:

1. `Store.set_fuel(slice)` enforces Wasmtime instruction fuel for **one**
   synchronous call and hard-traps a runaway guest.
2. The host-owned `LifetimeFuelBudget` starts with the Store fuel **remaining
   after instantiation** and is decremented by actually consumed fuel after
   each completed guest call. `slice=min(requested, remaining)` cannot
   replenish the lifetime quota, even if a guest returns or cooperates
   repeatedly. On exhausted, invalid or inconsistent fuel accounting,
   the existing tenant retirement path revokes that incarnation's Store.

These are independent from the 128-edge **advisory fairness** counter. The
lifetime budget never resets on a dispatch; only a new admitted tenant
incarnation can receive a new quota. Dedicated Rust regression tests cover
multiple full/partial calls, the 512/128 boundary, sibling independence and
untrusted fuel accounting. Production OS isolation, authenticated AOT
artifacts, and compiler-injected Wasm guest safepoints remain mandatory.
