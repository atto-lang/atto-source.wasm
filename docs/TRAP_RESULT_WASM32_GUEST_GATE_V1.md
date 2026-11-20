# Canonical trap-to-Result wasm32 guest gate (v1)

**Status:** compiler-backed gate authored; exact-head real guest execution is **NOT_EXECUTED** in this PR. This is not a compiler or public compiler release.

Normative authority: https://github.com/atto-lang/atto-spec/blob/main/language/trap-result-v1.md. The historical `scripts/verify-trap-wasm.mjs` remains available to reproduce the superseded Option-returning playground artifact. It is not proof of current AttoLang v1 semantics.

This gate uses a Rust-authored browser/Wasm compiler (atto-source.rs #331), not the LLVM core-Wasm scalar bridge. The two profiles differ: do not authorize browser `atto` imports under the zero-import LLVM `core-wasm.i64-v1` profile.

## Canonical fixture and runtime obligations

`tests/fixtures/trap-result-v1/result-existing.atto` is byte-identical to conformance PR #68 `fixtures/trap-result-v1/trap-existing-result.atto`, Git blob SHA-1 `2d71c15eb4e2f9f5b9bf42b5eef8ce3271d8106e`. The expression returns `42` by matching a single `Result<int,Error>` after trapping an existing Result. No double wrapping.

The verifier also compiles and executes an ordinary thrown `Error` caught as `Err`, verifies returned `Err` remains data, rejects retired `Option<int> = trap int`, rejects non-Error throws, and requires signed-i64 overflow panic to bypass trap. It uses the supplied compiler's actual Wasm output and Node's `WebAssembly.Instance`, not a JS implementation of the language.

## Commands

Source-only host tests (not guest proof):

    node --test tests/trap-result-verifier-v1.test.mjs

Guest gate (requires independently reviewed compiler and the exact source blob):

    node scripts/verify-trap-result-wasm.mjs /trusted/atto_compiler.wasm \
      tests/fixtures/trap-result-v1/result-existing.atto \
      <reviewed-compiler-sha256-64-hex> \
      2d71c15eb4e2f9f5b9bf42b5eef8ce3271d8106e

An artifact SHA-256 identifies bytes but does not authenticate the compiler builder. Require source head/tree, verified source-to-binary provenance, executable Wasm guest outputs, negative no-artifact behavior and independent review.

## Nonclaims and dependencies

Not verified: general Error subtype union joins, actor-local traps, suspension, TaskScope, TenantVM security, external I/O, or multi-file source linking. Zero-step CI, unavailable compiler and skipped tests are NOT_EXECUTED.

Conformance #68 owns canonical semantic fixtures, Rust #331 owns compiler lowering, and this Wasm branch owns the missing artifact verifier. Wasm migration #49 remains independent but must be reconciled before merging; no history squashing.
