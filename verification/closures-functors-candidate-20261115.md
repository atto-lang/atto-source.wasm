# Closures/functors exact-site Wasm candidate proof

Atto source-to-Wasm compilation is implemented in the Rust atto-source.rs
repository. This repo does not independently compile AttoLang source.

Site example PR: https://github.com/atto-lang/atto-lang.github.io/pull/126
Site source Git blob: 5d3fa82fa5c554f2a92ad7c5bb75f43a7dc7c977
Compiler draft PR: https://github.com/atto-lang/atto-source.rs/pull/134
Compiler source head: 2ce03b0ebbb9473dbefcfe5918dda446216fd1a0
Compiler source tree: 4598100f13a81587264356a5a6cddea43370fa3f
Source-exact Rust/Wasm conformance: https://github.com/zed-pkg-test/oreslang-private-pr-validation-20261012/actions/runs/43749267144

Run node --test tests/closures-functors-policy.test.mjs for source-free pin
and tampering tests. These are NOT guest runtime execution evidence.

For a privately retained candidate binary, run:
node scripts/verify-closures-functors-wasm.mjs <candidate.wasm> <exact-example.atto> <candidate-sha256> <source-head> <source-tree>

The artifact-driven verifier checks exact sample source, exact compiler source
head/tree, SHA-256 bytes, ABI v2, compiler import isolation, bounded buffers,
a real guest returning 84, deterministic recompilation and fail-closed rejection
for mutable/shadowed captures and escaping closure factories.

All candidate checks remain PRIVATE and do not authorize disclosure or
update the public playground compiler binary. The example stays preview-only
until independent code review, approved compiler digest, protected GitHub Pages
release, and live website verification.
