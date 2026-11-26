# atto-source.wasm: std.assert candidate and atto-test assertions

**Status: SOURCE_ONLY / NOT_EXECUTED.** This is a backend-local implementation candidate, **not proof of compiler, AOT or runtime parity**.

- `stdlib/std/assert.atto` follows [atto-spec#114](https://github.com/atto-lang/atto-spec/pull/114): a statically imported `std.assert` module, `true(bool)`, `false(bool)`, `equal<T: Eq>(expected, actual)`, `not_equal<T: Eq>(expected, actual)`, `fail(String)`. On failed condition, throw typed guest `AssertionError extends Error`; never process-abort or actor panic.
- `stdlib/std/test_assert.atto` provides an **independent** `TestOutcome(passed, message)` source candidate for a future backend-local `atto test` adapter; it returns values on failed checks. Its type must be integrated with the compiler's test runner; do not assume the Java test runner's type is present here.
- `tests/fixtures/std-assert-v1/*.atto` are authored cases, not independently run tests; `tests/std_assert_source_contract.test.mjs` is a source-only lexical guard runnable with `node --test tests/std_assert_source_contract.test.mjs`. That gate does not compile Atto.
- Expected-first/actual-second arguments evaluate once, left to right. `Eq` comparison must be statically checked with no type coercion, implicit truthiness, pointer equality, arbitrary stringification or evaluation duplication. Runtime calls cannot disappear under release, AOT or optimization.
- Preserve the backend's existing import/error implementation and enforce module-identity/security bounds; no host-language assertion macro can stand in for guest execution.

## Backend-specific missing evidence

Worker host simulation is not guest execution; require AOT Wasm compiler-produced exports, typed Error and worker isolation tests.

Required real evidence: compiler bind/typecheck of `pkg "std.assert"`, accepted qualified reserved-word members; typed and catchable guest failure; negative mixed-type rejection; success/failure with optimizations; full AOT target receipt if supported; actor/worker isolation of failures; exact current-head nonzero-step CI. Mark each missing result NOT_EXECUTED and do not merge until verified. No private cross-org CI mirroring absent independently approved export controls.

Related integration owners: [Java#1757](https://github.com/atto-lang/atto-source.java/pull/1757), [spec#114](https://github.com/atto-lang/atto-spec/pull/114), [Rust#401](https://github.com/atto-lang/atto-source.rs/pull/401), [LLVM#317](https://github.com/atto-lang/atto-source.llvm/pull/317).
