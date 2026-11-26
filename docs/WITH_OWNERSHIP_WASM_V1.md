# Wasm32 contextual `with` ownership readiness gate

Wasm source execution is delegated to the **pinned actual LLVM compiler**
with an independently verified binary SHA-256 and source SHA.
`verify-real-compiler.mjs` now calls that frontend on the unchanged
`contracts/with-ownership-v1/contextual-with-scalar.atto` guest fixture,
requires compiler-owned `WITH_BACKEND_UNSUPPORTED`, rejects compiler
crashes/IR output, verifies binary pin after use, and requires that the Wasm
artifact publisher create **no release pointer**.

This is **fail-closed compiler admission**, not `with` wasm32 execution.
No host-side JS evaluator, worker-message copy or syntactic AST shim can
claim Java/Truffle record/class copy parity.

Run the host diagnostic checks with `node --test
tests/with-ownership-frontend-gate.test.mjs`. For actual compiler evidence,
run `npm run test:real-compiler` with a pinned LLVM binary incorporating
the reviewed LLVM `WITH_BACKEND_UNSUPPORTED` admission PR; record both
compiler hashes and exported artifact/non-publication results.

Shared guest contract: oreslang-platform-conformance draft PR #693.

**NOT EXECUTED on this PR head:** pinned compiler integration, wasm32
guest execution of `with`, LLVM/Forge/.NET parity, full AOT.
