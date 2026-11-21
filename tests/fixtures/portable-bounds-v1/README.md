# Wasm portable bounds v1 — candidate

This copies the **same exact** `.atto` source Git blob from Java PR #3133, conformance draft #742 and LLVM draft #1848. Shared `bounds.atto` Git blob SHA-1: `a8ae98d0de39596ffad3a00be02d8f1e255de777`.

The source-only Node test validates the canonical byte pin. The **separate required guest test** needs a real independently approved LLVM compiler binary and source SHA/tree, compiles the imported `.atto` source to core wasm32, verifies release hash and import-free capability admission, executes the actual guest in an isolated worker expecting i64 42, and checks typed-source rejection without release publication.

Run `npm run test:portable-bounds-wasm32` with exact `ORESLANG_LLVM_COMPILER`, `ORESLANG_LLVM_COMPILER_SHA256`, `ORESLANG_LLVM_SOURCE_SHA`, `ORESLANG_LLVM_SOURCE_TREE`, `ORESLANG_LLVM_SOURCE_ROOT` (absolute, same HEAD/tree) and `ATTO_BOUNDS_WASM_EXPECTED_HEAD` in a trusted exact-head source checkout. No Python used.

**NOT EXECUTED**. Normal `npm test` skips the real guest test unless required mode is set; a skip or source-only pass **does not** establish compiled Wasm parity, Wasmtime isolation, sealed AOT or zero-GC.
