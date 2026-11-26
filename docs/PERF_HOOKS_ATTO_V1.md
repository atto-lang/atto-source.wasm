# Backend-owned AttoLang perf hooks v1 — wasm
 
**Status: source candidate and static admission tests ONLY; guest execution, JIT emission and strict AOT not verified.**

This repository maintains its own `.atto` core/stdlib/alloc implementation. It does **not** import shared runtime library source from `atto-common-source` and it may use different backend-specific code, while keeping stable numeric probe IDs and equivalent event semantics.

## Implemented source candidates

- `stdlib/perf.atto`
- `stdlib/perf_ids.atto`
- `stdlib/alloc/perf_trace_buffer.atto`

Canonical probe identity: 23 actor.user_mail.queue; 24 actor.user_mail.dispatch;
25 scheduler.turn.queue; 26 future.waiter.notify; 27 map.set;
28 map.get_optional; 29 map.delete. These are static and never derived
from the order of declarations or runtime names. Registry and offline
generation contract: `atto-lang/atto-common-source#136`.

## Backend-specific requirements

Wasm: the compiler must lower monotonic timing through an explicitly authorized worker/import capability, or reject the import. No ambient clock, JS interpreter fallback, and no detached Worker access to actor-owned buffers. A closed Wasm guest module is required for AOT credit.

## Instrumentation and safety

A future typed compiler pass must choose fixed sites and generate a complete
AOT probe plan. Compile-time OFF removes clock calls and recording entirely.
Runtime disabled or unsampled paths must branch before clock access and
allocation. Enabled events are numeric only; secrets, payload data, actor
state and unbounded labels must not enter the hot path. The software
buffer candidate is owner-local and drops at its fixed capacity (up to
65536 entries) without waiting, expanding or exporting. Producer-side
network, filesystem, stdout, logging and blocking are prohibited.

AOT must always work with JIT absent. Optional JIT may optimize previously
assigned sites but may not expand macros at runtime, mint capabilities, or
alter output semantics. Scope exits include normal returns, throw/raise,
panic, cancellation, await/resume and actor lifecycle boundaries; the
compiler must prove each executes or suppresses hooks correctly and exactly
once per defined event, not merely rely on manually paired user calls.

## Current validation

```sh
node --test tests/perf_source_contract.test.mjs
```

That command checks static source invariants only. It is **not** proof
of parser/import acceptance, host or guest execution, native AOT, browser
Wasm module execution, runtime JIT, or performance characteristics.
Missing/zero-step CI jobs are `NOT_EXECUTED`. A complete backend parity
receipt requires exact head SHA, complete source tree, successful material
runner steps, positive/negative compiled guest fixtures, disabled-path
allocation/clock evidence, overflow/ownership tests and a linked program-
specific strict AOT artifact (or closed Wasm module). Use the shared
versioned contract but keep library source independently maintained.
