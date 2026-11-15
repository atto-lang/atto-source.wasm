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
