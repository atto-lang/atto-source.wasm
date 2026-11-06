# Canonical `atto.core` Wasm guest execution candidate

This change adds a **real compiler-backed** test, but does not assert that
it has run. The canonical `core-numeric.atto` fixture has Git blob
`395695e5b1a6c40d56db323943b34f1012b76c7c` and imports
`atto.core/numeric`, not `ores.core/numeric`.

- Ordinary PR workflow checks source bytes and skips the actual compiler/guest test.
- To run the compiler-backed test, build a compatible LLVM `oreslang-llvmc`
  (LLVM integration PR #1454), pin its exact Git HEAD and binary SHA-256, and run
  `ATTO_REQUIRE_COMPILER_GUEST=1 node --test tests/atto-library-core-guest.test.mjs`
  with `ORESLANG_LLVM_COMPILER`, `ORESLANG_LLVM_COMPILER_SHA256` and
  `ORESLANG_LLVM_SOURCE_SHA` set. The test **fails** if any required pin is missing.
- It then compiles the `.atto` source through the native LLVM backend,
  checks Wasm artifact provenance, isolates and executes the guest (expects
  `42`), rejects all host imports/capabilities, and requires the **compiler**
  to reject canonical Std, allocator-without-provider, unknown Core, and
  traversal-looking imports without partial IR.

No private source is mirrored to another organization; the existing
source-owned, manual LLVM/Wasm integration workflow remains the authorized
cross-repository build pathway. Do not promote source-only or skipped tests
to compiler-backed evidence. CI with `steps=null` is runner admission failure.
