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

## Real compiled-guest lifetime fuel regression

`aot-host/tests/smoke.sh` compiles a zero-import, bounded-memory Wasm
counter module and precompiles it with the same AOT pipeline as the tenant
store-isolation smoke. A debug-only, feature-gated
`--tenant-lifetime-fuel-smoke` entry uses a hard 512-fuel **incarnation
ceiling** to make the actual guest exhaustion observable in a short test.
The runner repeatedly invokes one offender with per-call 128-unit slices,
proving multiple successful guest calls first, then a real fuel-origin error,
Store retirement, stale-handle rejection, healthy sibling progress and
clean reincarnation. Replacing the lifetime ledger with an unconditional
`Store.set_fuel(requested)` renewal must make this regression fail.

The 512 ceiling is available **only** with the explicit insecure Cargo
debug profile/feature and is not configurable from untrusted source. The
ordinary registry uses the independently enforced fixed MAX_FUEL ceiling;
both account for Wasmtime instantiation using the Store's remaining fuel.
This is genuine guest execution evidence only when `smoke.sh` itself runs
to completion on an assigned CI worker. The production runner remains
disabled until artifact authentication and process isolation are available.


## Lifetime fuel, shutdown and restart acceptance

The debug-only compiled-guest smoke now reads the **host-owned** remaining
lifetime fuel before and after each successful Wasmtime call; the amount
must strictly decrease on every turn. The exhaustion case must occur
after multiple successful guest results, with remaining aggregate quota
no greater than the 128-unit dispatch slice. A healthy sibling keeps
its independent counter and fuel. The test then quiesces the sibling,
rejects calls and fuel-ledger read-back while quiescing, destroys its
Store, rejects old handles, and admits a fresh incarnation with its
own memory/identity/initial result while the other reincarnated
offender continues. No guest-exposed lifetime fuel introspection was
added; read-back is present only in the already-insecure debug smoke
build. Genuine success still requires an executed native Wasmtime
AOT smoke with exact-head provenance, not a Node Wasm fixture pass.
