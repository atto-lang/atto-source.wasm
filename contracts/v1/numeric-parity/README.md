# Numerical parity admission contract v1

All five private repos track the same immutable fixture blob
`cb28b5678d380f02c5e4e43bd763da04bdb996fe`, first staged on Java
PR #1033 and LLVM PR #427. Copy it without changing a byte.

## Evidence is tiered

- `reference_only`: Python checks the independently defined fixture; **no Oreslang execution**.
- `implemented_unverified`: code exists, but exact-head compiler/guest CI has not passed.
- `delegated_unverified`: Wasm relies on the external native LLVM compiler; a
  passing Node sandbox test alone says nothing about numeric source semantics.
- `unsupported_explicit`: no guest implementation; reject unsupported source
  instead of lowering through binary64 or another incompatible domain.
- `blocked_unsound`: a known mismatch (e.g. Java source f32 aliases float).
- `needs_audit`: behavior not yet established against cross-backend contract.
- `verified_compiled`: ONLY after exact-head source compiler/guest run,
  positive and negative case counts, pinned fixture SHA, and independently
  reviewed workflow evidence are recorded. The manifest gate validates
  structure but **cannot authenticate external URLs**; security review is still required.

No backend currently declares `verified_compiled` for these features.
These manifests document current gaps, not fulfilled parity. Run:

```sh
python3 -m unittest discover -s tests -p 'test_numeric_*.py' -v
```

## Required implementation order

1. Agree on signed-i64 overflow/trap behavior, binary64 NaN/signed-zero,
   integer/floating comparisons, and source int/int division.
2. Implement real f32 and f64 typed lowering; forbid implicit BigInt/Decimal
   narrowing; match IEEE special-value rules.
3. Implement resource-bounded owned BigInt and Decimal in each native backend.
4. Add deterministic exact-accumulator `Matrix<Decimal>` with ownership
   and explicit rounding policy.
5. Run all fixtures through **actual** Java/GraalVM, LLVM, .NET Native AOT,
   OresForge, and real LLVM->wasm32 guest execution. No mock compiler can pass.
6. Retain explicit unsupported-feature negatives on bootstrap backends until
   native implementation is ready.

The .NET and Forge engines currently implement small checked-i64 subsets;
Wasm is LLVM-dependent and exposes only a core `() -> i64` ABI. Neither
running the reference Python oracle nor checking these manifests establishes
numerical feature parity.
