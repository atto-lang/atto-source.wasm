# Private Rust/Wasm diamond-inheritance validation receipt — 2026-11-15

**Status:** PASS for the bounded source-compiled trait/multiple-inheritance subset tested here. **Not a public release authorization.**

## Source and exact-file provenance

- Rust compiler: `atto-lang/atto-source.rs` draft PR #137
- Rust compiler source head: `f3f47688fa91ee31b815fd14382d009821dc5d66`
- Rust compiler source Git tree: `e9166681a6f645bf3d2ef9814d5b503f98361df4`
- Playground example: `atto-lang/atto-lang.github.io` draft PR #130, `play/examples/preview/diamond-inheritance.atto`
- Exact playground sample Git blob SHA-1: `05814acb37c0335c03294875b870560a2839031d`
- Exact artifact verifier Git blob SHA-1: `e34dabcefee21d59b6f44019de1e7737ba2730ec`
- Test carrier: private `zed-pkg-test/oreslang-private-pr-validation-20261012`, commit `f6b0aaebe7743489fb1ffe0b9942e9d167b634d9`
- [GitHub Actions run 43749774181](https://github.com/zed-pkg-test/oreslang-private-pr-validation-20261012/actions/runs/43749774181), job `132920936223`: completed successfully

The private carrier was an **exact-blob subset snapshot**, not a full-tree source mirror. A manifest verified SHA-1 for 21 Rust/Cargo files and 12 new fixture files before compilation. The checked-out verifier and site sample also matched the exact Git blobs above.

## Actual executions

- Rust `cargo test --lib`: **4 passed**
- Native release compiler `attoc`: built successfully
- Rust-authored compiler built for `wasm32-unknown-unknown`: built successfully
- Conformance fixture results: **3 accepted** and **9 rejected**, with native-versus-wasm32 compiler guest bytes identical for accepted fixtures; their guest WebAssembly actually executed
- Artifact-driven verifier `scripts/verify-diamond-wasm.mjs`: **PASS** on the exact (unmodified) playground sample
- Guest output: `Ada\nhello\nroot\ndiamond resolved\n`; guest `main` returned `0`
- Negative mutations rejected **without producing a guest**: `E_AMBIGUOUS_MEMBER`, `E_OVERRIDE_REQUIRED`, `E_OVERRIDE_SIGNATURE`

## Build artifact identifiers (private candidate only)

- Compiler WebAssembly SHA-256: `e62607c60fc00dec6ee819702a725014f8ac78b7b7114e1fda58d3d4bf206958`
- Guest WebAssembly SHA-256 for site sample: `ca714cadda247ef92e6ecfe645c73129efa54750cb297cdf47f11f62556b01bd`
- Guest size: 1,965 bytes

These digests describe a privately compiled candidate and a generated guest. They are **not independently approved for public disclosure**, and this repository does not contain either artifact. The site continues to use its older pinned public compiler and must keep this language example labeled non-executable. A reviewed compiler release, deployed digest/receipt pin update, and browser integration tests are required before enabling Run/Format for this example.

## Scope limit

The compiled subset statically flattens concrete class inheritance and trait defaults with origin-aware diamond deduplication. There is no general dynamic upcasting/vtable dispatch, constructor chaining, or inherited private-member support in this milestone.

## Follow-up full-tree hardening audit — supersedes subset-only validation

The source compiler was hardened after the initial subset run: inherited static
methods no longer enter derived instance method tables, and a child attempting
to hide an inherited instance method with a static function is rejected with
`E_STATIC_INHERIT_CONFLICT`. Ten new regression fixtures cover method lookup,
trait-origin deduplication, interface signatures, inherited-field ambiguity,
private-field gates and prohibited static overrides.

- [Full Git tree exact-SHA carrier run 43755317560](https://github.com/zed-pkg-test/oreslang-private-pr-validation-20261012/actions/runs/43755317560): **SUCCESS**
- Carrier branch: `validation/atto-diamond-full-tree-hardened-20261115`
- Carrier commit: `737c4b99014474820e781ecee38d1dc5124f6ed3`
- Source compiler PR #137 head: `2782efd9ff61677afdfbd9889cea7fd38d2cd5fd`
- Upstream source Git tree: `3b6e05aac0eb6dffb521e513cb7f968ad7546e52`
- Mirrored `source/` Git tree: **exactly the same SHA**, including all 401 Git blobs, file modes, paths and directory hierarchy; no extra or missing files
- Source workflow in the source org did not reach a runner (`runner_id=0`, zero execution steps); test carrier's own runner completed all jobs

**Full source tree verification results:** 128 native Cargo/Rust tests, 381 guest
conformance cases, 344 native-versus-wasm32 compiler byte comparisons, 28
adversarial actor-mailbox tests, 29 receiver ABI checks, and 11 Chromium worker
checks all passed. Native `attoc` and wasm32 compiler builds passed. The exact
`/play` sample and its three fail-closed mutations passed against genuine
generated guest Wasm. Guest `main` returned 0 and printed the four expected
lines. All of this ran without a cross-org checkout or repository access token
being supplied to the carrier.

- Full-tree candidate compiler Wasm SHA-256: `83476186fd7c92f6b16e49df786b3883598dcdf8076052db03195fc86f90ef86`
- Full-tree guest Wasm SHA-256: `ca714cadda247ef92e6ecfe645c73129efa54750cb297cdf47f11f62556b01bd`

The earlier candidate compiler digest remains as historical evidence of the
subset validation, **not** as the latest candidate. Neither compiler digest is
an approved public compiler release. No binary was uploaded from this validation
workflow. The playground stays preview-only until reviewed compiler release and
public pin/browser validation.
