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
4. **Compatibility gate:** standalone `const` remains a compile-time constant under the current Java reference. A runtime-dependent readonly initializer belongs in `val` or the proposed immutable-by-default type-first `int x = runtime_expr`; `let` alone permits rebinding. An implementation that admits `const x = runtime_call()` must be recorded as a **semantic divergence**, not silently credited as parity.
5. `as?` has type `Option<T>` where implemented and never silently unwraps. A cast requiring a runtime tag must perform a real type check; an unchecked numeric bitcast, dynamic handle reinterpretation, implicit conversion or `null` fallback is prohibited.
6. No implicit bool↔int, string↔int, lossy numeric, structural-to-nominal, owner-to-borrow, or tag-erasing conversion. Runtime-unreifiable casts must reject before executable artifact creation.

## Bounded implementation status

| Scenario | Java/GraalVM | LLVM | .NET NativeAOT track | wasm32 | Cranelift JIT stage-0 |
| --- | --- | --- | --- | --- | --- |
| `int` typed, inferred or identity cast | PR #2405 authored compiler tests | PR #1256 authored native compiler slice | PR #282 authored structured parser/CFG/CIL slice | PR #219 pinned LLVM-to-wasm32 path | **Separate draft branches:** #21 typed readonly local slice; #22 checked-i64 identity cast slice. Neither single tree combines both yet. |
| `bool` typed, inferred or identity cast | Implemented; tests | PR #1256 compiler slice | PR #282 structured parser/CFG/CIL slice | PR #219 exercises pinned LLVM compiler | Unsupported/reject; no bool type/ABI |
| `string` inference/checked scalar cast | Java supported | Native String ABI; new tests need executed proof | Not implemented in structured scalar subset | Not admitted without proven import-free runtime | Unsupported/reject |
| Expression/branch/call inference | Java typechecker | Constrained native scalar slice | Constrained typed scalar subset | LLVM compiler delegated | #21 admits bounded local i64 references; branches, helper calls and generalized inference remain unsupported |
| `as?` / `Option<T>` | Java checked Option result | Not lowered; reject | Not lowered; reject | Not lowered; reject | Unsupported/reject |
| Dynamic/nominal/ADT/generic checked casts | Java feature-specific checks | Not generally lowered | Not lowered | Not independently lowered | Unsupported/reject before CLIF generation |

A **source file that merely compiles** is not runtime guest evidence; a **host arithmetic result** is not compiler evidence; a **skipped test** and **zero-step Actions failure** are not tests executed.

## Exact-head verification sequence

- Java PR #2405: verify parser/typechecker negatives, JUnit execution and Graal guest output at the exact PR source tree and compiler commit.
- LLVM PR #1256: native C++ build, `native_source_bool_${mode}` release/sanitizer CTest guest compile/link/execute, exact source SHA, compiler binary SHA, signed-i64/ownership negatives, full suite.
- .NET PR #282: `dotnet run --project verification/Ores.Net.Tests`, typed structured AST/CFG independent oracle and deterministic emitted CIL interpreter. Then actual NativeAOT build and executable test at matching commit; these are separate receipts.
- wasm32 PR #219: `ORESLANG_CAST_PARITY_REQUIRED=1 npm test` with `ORESLANG_LLVM_COMPILER`, independently verified LLVM source revision `ORESLANG_LLVM_SOURCE_SHA`, compiler digest `ORESLANG_LLVM_COMPILER_SHA256`, clang/target and Wasm guest SHA receipts. Require non-skipped guest cases, no host imports, no release on negative.
- Cranelift PRs #21 and #22: verify **each branch's distinct exact head**; #21 tests bounded readonly locals and checked identity casts, #22 tests checked-i64 identity casts. Reconcile overlapping compiler patches onto **one independently reviewed head** before crediting both. Run `cargo fmt --all -- --check`, `cargo test --locked --all-targets`, and Clippy; require real JIT execution plus rejected-code no-IR receipts. No actor/heap/boolean parity is implied.
- Compare the same source scenarios across backends (not unrelated host-only claims). Capture first actionable compiler diagnostic and minimal counterexample; fail closed for unsupported cases, **do not quietly weaken the test**.
- Keep CI runner admission, host policy tests, actual compiler execution, guest receipts, NativeAOT evidence, independent approval and branch protection as separate merge gates. Private source cannot be mirrored to another organization under an active transfer hold.

**This document does not certify full five-backend parity.** It records exactly what is supported, what is being implemented, and which independent executed gates must pass before making such a claim.

## Smallest five-backend source intersection (new; all execution unverified)

The *identical* guest source must be checked by independent backend
compilers and executed on each backend before any 5/5 result can be published:

```ores
pub fnc main():int{return (7 as int)+35;}
```

Expected native/guest integer result: **42**. A chained identity cast,
`(7 as int as int)+35`, also must produce 42. In contrast,
`return 7 as bool;`, `return true as int;` and the out-of-range
`return 9223372036854775808 as int;` must fail closed with a
compiler-owned type/range diagnostic, and must not produce an executable
release artifact. Those are *source* oracles; running host-language arithmetic
instead of Oreslang is not equivalent evidence.

Cranelift implements this as a **signed-i64 identity cast** in its intentionally
bounded parser; a **separate draft** also admits typed and constant scalar locals.
These branches must be reconciled on one exact tree before combined support is
credited. It does not establish mutable `let`, generic inference, bool types,
actors, task isolation, or runtime-checked dynamic casts. For Wasm, the currently
documented path uses a pinned LLVM compiler and independently executes wasm32;
that does **not** make Wasm a distinct frontend compiler implementation.
A five-backend green claim requires an exact matching source corpus, each
compiler/runtime artifact digest, non-skipped guest run, exact output/exit,
negative-codegen rejection, and independently verified source HEADs.

## Compatibility and adversarial merge gates (2026-11-01)

The Oreslang user-facing rule **immutable by default** does not erase the
current compile-time-constant versus readonly-runtime-binding distinction.
Test **both** cases on every compiler before claiming local-binding parity:

```ores
// Reference-compatible: checked compile-time constant, value 42.
pub fnc main(): int { const x = 6 * 7; return x; }
// Proposed immutable-by-default runtime binding: value 42; requires admission.
pub fnc main(int n): int { int x = n + 1; return x; }
// Negative: standalone const cannot read runtime-dependent parameter.
pub fnc main(int n): int { const x = n + 1; return x; }
```

Additional **source-level fail-closed** cases: `7 as bool`, `true as int`,
`7 as? int` without tagged Option lowering, `7 % 3`, `7 ^ 3`,
`7 ^^ 3`, `9223372036854775808 as int`, and an immutable local
rebinding attempt. The correct behavior is a compiler-owned rejection **before
native/wasm/PE artifact publication**, not a successful host arithmetic result.

The same canonical `.ores` source bytes and diagnostic categories should be
submitted to all five targets. Java and LLVM are different frontends; Wasm in
this slice reuses the LLVM frontend and is therefore a **distinct emitted guest
runtime**, not an independent source frontend. Cranelift #21/#22 are separate
source heads, not cumulative functionality. Program authors must not weaken
negative cases or change declaration kinds to manufacture a green result.

**Known open contract drift:** Java/LLVM/Wasm/.NET scalar-cast test drafts
currently include runtime-initialized standalone `const` positives. Reconcile
the implementation and assertions with the Java language reference and common
source PR #203 **before merge**, and preserve any red cases as evidence of gaps.
All tests and source statements in this document are authored candidates, not
executed end-to-end five-backend evidence.
