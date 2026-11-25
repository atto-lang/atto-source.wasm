# Backend-owned Atto library policy slice

This repository (atto-source.wasm) owns its own native `.atto` source.
No dependency on `atto-common-source` is required to build these modules,
and no byte-for-byte source identity with other compilers is mandated.

## Layer boundaries

- `stdlib/core/byte_budget.atto` is freestanding, pure and allocation-free.
- `stdlib/alloc/capacity_plan.atto` is a pure policy helper for an explicit
  allocator. Actual allocation and ownership are NOT implemented by this file.
- `stdlib/std/stream_watermarks.atto` provides stream backpressure decisions.
  Channel admission, actor scheduling, permission checks and I/O are still
  enforced by the runtime.

All public function names are snake_case. Signed byte counts must be nonnegative.
For invalid inputs, predicate functions fail closed, `bytes_left` returns -1,
and `next_capacity` returns -1. Max budgets are inclusive. Growth uses a
backend-local initial capacity floor of 4 items; this value may vary
across compilers without changing safe ownership or streaming contracts.

## Verification state

`contracts/atto-library-policy-v1.json` records 23 proposed behavior cases.
These are source-only fixtures, **not evidence of compiler guest execution**.
Integration requires verified native Atto parsing, local import resolution,
guest execution, and platform/AOT tests before claiming implemented library
availability. An accepted policy decision never authorizes memory or I/O.

Do not turn these `.atto` implementations into Java/C#/C++/JS runtime bodies.
Backends may expose minimal, sealed low-level primitives, and future language
libraries should use those primitives from native Atto code.

## Native core memory/atomic policy addition

`stdlib/core/mem.atto`, `stdlib/core/ptr.atto`, and
`stdlib/core/atomic.atto` are independently maintained freestanding
arithmetic and ordering source candidates. See `docs/CORE_MEM_PTR_ATOMIC.md`
and `tests/core-memory-policy-source.test.mjs` (63 source-only cases).
This does not add raw pointers, atomic storage, lifetime authorization,
compiler-linked imports, or AOT guest execution; those are NOT_EXECUTED.
