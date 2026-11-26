# Canonical trap-to-Result wasm32 guest gate (v1)

**Status:** compiler-backed gate authored; exact-head real guest execution is **NOT_EXECUTED** in this PR. This is not a compiler or public compiler release.

Normative authority: https://github.com/atto-lang/atto-spec/blob/main/language/trap-result-v1.md. The historical `scripts/verify-trap-wasm.mjs` remains available to reproduce the superseded Option-returning playground artifact. It is not proof of current AttoLang v1 semantics.

This gate uses a Rust-authored browser/Wasm compiler (atto-source.rs #331), not the LLVM core-Wasm scalar bridge. The two profiles differ: do not authorize browser `atto` imports under the zero-import LLVM `core-wasm.i64-v1` profile.

## Canonical fixture and runtime obligations

`tests/fixtures/trap-result-v1/result-existing.atto` is byte-identical to conformance PR #68 `fixtures/trap-result-v1/trap-existing-result.atto`, Git blob SHA-1 `2d71c15eb4e2f9f5b9bf42b5eef8ce3271d8106e`. The expression returns `42` by matching a single `Result<int,Error>` after trapping an existing Result. No double wrapping.

The verifier also compiles and executes an ordinary thrown `Error` caught as `Err`, verifies returned `Err` remains data, rejects retired `Option<int> = trap int`, rejects non-Error throws, and requires signed-i64 overflow panic to bypass trap. It uses the supplied compiler's actual Wasm output and Node's `WebAssembly.Instance`, not a JS implementation of the language.

## Commands

Source-only host tests (not guest proof):

    node --test tests/trap-result-verifier-v1.test.mjs tests/trap-result-guest-outcome.test.mjs

Guest gate (requires independently reviewed compiler and the exact source blob):

    node scripts/verify-trap-result-wasm.mjs /trusted/atto_compiler.wasm \
      tests/fixtures/trap-result-v1/result-existing.atto \
      <reviewed-compiler-sha256-64-hex> \
      2d71c15eb4e2f9f5b9bf42b5eef8ce3271d8106e

An artifact SHA-256 identifies bytes but does not authenticate the compiler builder. Require source head/tree, verified source-to-binary provenance, executable Wasm guest outputs, negative no-artifact behavior and independent review.

## Nonclaims and dependencies

Not verified: general Error subtype union joins, actor-local traps, suspension, TaskScope, TenantVM security, external I/O, or multi-file source linking. Zero-step CI, unavailable compiler and skipped tests are NOT_EXECUTED.

Conformance #68 owns canonical semantic fixtures, Rust #331 owns compiler lowering, and this Wasm branch owns the missing artifact verifier. Wasm migration #49 remains independent but must be reconciled before merging; no history squashing.

## Guest trap versus host callback failure (2026-11-20)

The previous verifier accepted `!execution.ok && panic_code === 1` as an
overflow-panic witness. But its trusted JS print adapters could throw an
ordinary host-side `Error` (for example an invalid string pointer) after
guest code wrote `panic_code=1`. That combination is **not** evidence of a
real Wasm trap or of correct `trap` semantics.

The current verifier requires both a `WebAssembly.RuntimeError` during
`main()` and `panic_code === 1` for the overflow bypass. Ordinary
host `Error`, `RangeError`, `TypeError`, Wasm compilation and linking
failures cannot satisfy the witness. On all three positive executions the
verifier also requires `panic_code === 0`.

The local Node v22.16.0 targeted test
`tests/trap-result-guest-outcome.test.mjs` passed **2/2**, using an actual
hand-authored Wasm `unreachable` instruction and host-fault negatives.
The exact local test/helper Git blobs were verified against this PR:
`d929c2c2a35fa3238715366c021ee873eae6a02c` and
`4e65854e7fcbc669bd167d5fcbcd6aa1401db296`.
This is **host-policy verification only**. It is not proof of an Atto
compiler artifact or signed-i64 overflow source behavior. The trust model
also requires that this verifier's controlled import callbacks do not
themselves throw `WebAssembly.RuntimeError`; such callbacks must fail as
ordinary host errors. Real authenticated Rust compiler → Wasm guest positives,
negatives and exact-head CI remain **NOT_EXECUTED**.

## Trusted host import exception provenance (2026-11-20 follow-up)

A further verifier spoofing path existed: a trusted JavaScript print callback
could itself throw `WebAssembly.RuntimeError`, either intentionally or from
host implementation mistakes. Classification by `instanceof
WebAssembly.RuntimeError` and `panic_code === 1` alone would not distinguish
that host failure from a native Wasm trap.

The artifact verifier now wraps **every** fixed trusted `atto.print_*` host
callback through `guardHostImport`. Any callback exception, including a
`WebAssembly.RuntimeError`, is replaced with a bounded `HostImportFault`
rather than propagating the attacker-originated exception as a guest trap.
The wrapper does not expose the original error or its cause. The classifier
continues to require a native `WebAssembly.RuntimeError` and `panic_code=1`.
The gate's checked-positive successful guests must have `panic_code=0`.

Exact committed Git blobs:
- `src/trap-result-guest-outcome.mjs`:
  `5786a26b07b9de4789f54b306eb8bee1a34ac83a`
- `tests/trap-result-guest-outcome.test.mjs`:
  `4300088e1a5051fea3b6322cfdf22cb557307ff5`

The Node v22.16.0 local host-policy suite executed **4 tests, 4 passed,
0 failed, 0 skipped**, with local `git hash-object` matching both GitHub
blobs. The new test executes an actual hand-authored Wasm module that calls
`atto.print_i64`, injects both forged `WebAssembly.RuntimeError` and
ordinary host Error from that imported callback, verifies neither can qualify
as a guest panic, and checks the guarded successful callback still executes
exactly once. A separate actual `unreachable` Wasm module proves native
traps are still recognized. The exact-head workflow includes all four cases.

**Evidence scope is host verifier policy, NOT compiled AttoLang guest
semantics.** The current branch does not independently authenticate or run a
source-built Rust compiler Wasm artifact, nor assert cross-backend Error object
identity, actor cancellation, or Native AOT. Material exact-head GitHub Actions
execution and independent review remain required.
