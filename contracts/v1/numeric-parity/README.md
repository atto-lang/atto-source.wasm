# Numerical parity admission contract v1

All five private repos track the same immutable fixture blob
`cb28b5678d380f02c5e4e43bd763da04bdb996fe`, first staged on Java
PR #1033 and LLVM PR #427. Copy it without changing a byte.

## Shared real-source i64 corpus

`source-i64-cases.json` has Git blob
`bbc319c19ecd007109d33592e210091eb267e5a2`: seven Oreslang
signed-i64 source expressions (including both signed extrema), with
exact 64-bit reference results. A separate Python oracle checks the
immutable fixtures, **not compiled source**. Implemented guest adapters:

- Java `NumericPortableI64GuestTest`: execute all seven in GraalVM.
- LLVM `native_numeric_portable_i64_source.py`: compile real
  Oreslang -> LLVM IR -> Clang, link a C launcher, verify the complete
  signed-64-bit value rather than the 8-bit process exit code.
- .NET `verification/Ores.Net.Tests/Program.cs`: real source parser,
  typed i64 IR, and reference evaluator (Native AOT execution separate).
- Forge `verification/tests.cpp`: real source parser, checked IR,
  interpreter (assembly emitter remains constant-return bootstrap).
- Wasm `tests/numeric-source-parity.test.mjs`: pin the actual LLVM
  compiler executable, compile source to wasm32, execute with zero host
  capabilities and verify full-width `BigInt` results; **skips when the
  real compiler is not supplied**, and a skip never counts as parity.

## Shared signed-i64 overflow corpus

`source-i64-overflow-cases.json` is byte-identical to the Java, LLVM,
.NET and Forge corpus (Git blob
`2ce0b0ff5c52e54a788280fd64d67fa8dc32614a`), and is pinned in
`backend.json`. The four cases cover positive addition overflow,
negative subtraction overflow, multiplication overflow and nested unary
negation overflow. The Python gate validates the pinned bytes and
independent rejecting oracle. `numeric-source-parity.test.mjs` additionally
feeds each source through the pinned real LLVM->wasm32 compiler and accepts
exactly the two outcomes permitted by `reject-or-runtime-error`:
(1) an explicit Oreslang compiler diagnostic with **no** published atomic
release pointer, or (2) successful checked compilation into a pinned,
zero-import Wasm guest that raises an actual `WebAssembly.RuntimeError`
when executed. Guest validation failures, timeouts, toolchain errors and
normal wrapped i64 results are **not** accepted as an overflow proof.
The worker identifies actual runtime traps separately from admission errors.
Before accepting a runtime trap, the compiler bridge also verifies that the
**exact IR handed to Clang** contains the expected signed-i64 overflow
intrinsic, the associated extracted overflow flag, a conditional branch
using that flag, and its matching `llvm.trap` block. Unrelated instructions
and comment-spoofed guards are rejected. Four source-level safe near-boundary
companions must execute and return full-width i64 values. This is a
conservative attribution gate, not a formal proof of general arithmetic or
actor/ownership correctness. Its structural self-tests use independently
authored IR and do **not** establish compiled Oreslang parity.
The latter test **skips when a real pinned compiler is unavailable**;
it must not be counted as guest parity. `checked_i64_overflow` remains
`delegated_unverified`.

Actual-feature parity is **not established**: Actions attempts in the
source org have zero executed steps, and the bootstrap engines still
lack f32, f64, BigInt, Decimal, Complex, and Matrix implementations.
Cross-repo numerical work is tracked at
https://github.com/ores-truffle-oreslang/oreslang-source.java/issues/1068.

## Evidence is tiered

- `reference_only`: Python checks the independently defined fixture; **no Oreslang execution**.
- `implemented_unverified`: code exists, but exact-head compiler/guest CI has not passed.
- `delegated_unverified`: Wasm relies on the external native LLVM compiler; a
  passing Node sandbox test alone says nothing about numeric source semantics.
- `unsupported_explicit`: no guest implementation; reject unsupported source
  instead of lowering through binary64 or another incompatible domain.
- `blocked_unsound`: a known mismatch (e.g. Java source f32 aliases float).
- `needs_audit`: behavior not yet established against cross-backend contract.
- `verified_compiled`: **currently forbidden** by the fail-closed manifest gate.
  A self-declared workflow URL and case counts in the same PR are not a trusted
  proof. Implement independently approved/protected evidence verification that
  authenticates source and runner commits, actual executed positive/negative
  job steps and both fixture SHAs before enabling this state.

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
