# Scalar inference and checked casting — cross-backend conformance v1

Status: **authored contract and tests only; execution receipts not yet verified**.
Canonical source is Oreslang, not Java/C#/C++/JS host arithmetic.

## Semantics

```ores
const int annotated = 7;
const asserted = 7 as int;
const inferred = 7;
const named: int = 7;
```

These four declarations produce fixed, readonly bindings of static type `int`, value 7. They are NOT four interchangeable compiler operations:

1. `const int annotated = e` and `const name: int = e` independently **check an initializer against the declared type**.
2. `const x = e as int` first performs a **checked** expression cast and then infers the binding type from the cast result.
3. `const x = e` infers from the original expression without an explicit cast. This is a separate required regression test; a cast must never be used to conceal broken inference.
4. A `const` binding may receive a runtime expression; immutable binding is independent of whether evaluation happens at compile time. Only `let` explicitly grants rebinding.
5. `as?` has type `Option<T>` where implemented and never silently unwraps. A cast requiring a runtime tag must perform a real type check; an unchecked numeric bitcast, dynamic handle reinterpretation, implicit conversion or `null` fallback is prohibited.
6. No implicit bool↔int, string↔int, lossy numeric, structural-to-nominal, owner-to-borrow, or tag-erasing conversion. Runtime-unreifiable casts must reject before executable artifact creation.

## Bounded implementation status

| Scenario | Java/GraalVM | LLVM | .NET NativeAOT track | wasm32 |
| --- | --- | --- | --- | --- |
| `int` typed, inferred or identity cast | Implemented; PR #2405 tests | PR #1256 compiler slice | PR #282 structured parser/CFG/CIL slice | PR #219 exercises pinned LLVM compiler |
| `bool` typed, inferred or identity cast | Implemented; tests | PR #1256 compiler slice | PR #282 structured parser/CFG/CIL slice | PR #219 exercises pinned LLVM compiler |
| `string` inference/checked scalar cast | Java supported | Native String ABI; new tests need executed proof | Not implemented in structured scalar subset | Not admitted without proven import-free runtime |
| Expression/branch/call inference | Java typechecker | Constrained native scalar slice | Constrained typed scalar subset | LLVM compiler delegated |
| `as?` / `Option<T>` | Java checked Option result | Not lowered; reject | Not lowered; reject | Not lowered; reject |
| Dynamic/nominal/ADT/generic checked casts | Java feature-specific checks | Not generally lowered | Not lowered | Not independently lowered |

A **source file that merely compiles** is not runtime guest evidence; a **host arithmetic result** is not compiler evidence; a **skipped test** and **zero-step Actions failure** are not tests executed.

## Exact-head verification sequence

- Java PR #2405: verify parser/typechecker negatives, JUnit execution and Graal guest output at the exact PR source tree and compiler commit.
- LLVM PR #1256: native C++ build, `native_source_bool_${mode}` release/sanitizer CTest guest compile/link/execute, exact source SHA, compiler binary SHA, signed-i64/ownership negatives, full suite.
- .NET PR #282: `dotnet run --project verification/Ores.Net.Tests`, typed structured AST/CFG independent oracle and deterministic emitted CIL interpreter. Then actual NativeAOT build and executable test at matching commit; these are separate receipts.
- wasm32 PR #219: `ORESLANG_CAST_PARITY_REQUIRED=1 npm test` with `ORESLANG_LLVM_COMPILER`, independently verified LLVM source revision `ORESLANG_LLVM_SOURCE_SHA`, compiler digest `ORESLANG_LLVM_COMPILER_SHA256`, clang/target and Wasm guest SHA receipts. Require non-skipped guest cases, no host imports, no release on negative.
- Compare the same source scenarios across backends (not unrelated host-only claims). Capture first actionable compiler diagnostic and minimal counterexample; fail closed for unsupported cases, **do not quietly weaken the test**.
- Keep CI runner admission, host policy tests, actual compiler execution, guest receipts, NativeAOT evidence, independent approval and branch protection as separate merge gates. Private source cannot be mirrored to another organization under an active transfer hold.

**This document does not certify full four-backend parity.** It records exactly what is supported, what is being implemented, and which independent executed gates must pass before making such a claim.
