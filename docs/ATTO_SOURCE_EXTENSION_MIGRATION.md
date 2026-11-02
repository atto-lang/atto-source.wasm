# AttoLang source-extension migration for the Wasm bridge

AttoLang `.atto` is the canonical source extension for new source files. The Wasm repository does not maintain a second language parser: it reads a bounded source file and passes it to the externally supplied, digest-pinned `oreslang-llvmc` compiler, then links verified LLVM IR with Clang for the restricted zero-import core-Wasm guest.

## What changed in this PR

- New byte-identical `.atto` twins are staged for the ten mutable `examples/*.ores` fixtures used by the real compiler and AOT verifiers. A host test compares each `.atto` byte buffer to its retained `.ores` source twin.
- The real LLVM-to-Wasm verifier compiles `.atto` entrypoints, examples, positive scalar fixtures and temporary negative source paths.
- The real source-to-AOT verifier compiles the `.atto` example corpus.
- Compiler executable and source attestation use `ATTOLANG_LLVM_COMPILER`, `ATTOLANG_LLVM_COMPILER_SHA256`, and `ATTOLANG_LLVM_SOURCE_SHA` as the canonical names. Existing `ORESLANG_LLVM_*` values remain temporary fallback aliases so existing runner secrets/variables are not broken by code-only renaming.
- The manually dispatched private LLVM workflow still uses its existing `ORESLANG_LLVM_READ_TOKEN` secret and pinned LLVM source commit. It must be advanced to a reviewed/merged LLVM `.atto`-admission commit before a real `.atto` run; this PR deliberately does not build from an unmerged compiler PR or change private source authorization.

## Historical evidence retention

The immutable `contracts/scalar/v1` and `contracts/v1/semantics` source paths, JSON manifests and their historical `.ores` file identities remain unchanged. Their manifests and reviewed receipts are path/hash bound. The real guest verifier stages the verified historical scalar bytes into private temporary `.atto` files before invoking the compiler, so the new suffix is exercised without rewriting old evidence. No old receipt is reissued or promoted.

## Scope boundary

This establishes the Wasm bridge's intended `.atto` path handling and authors host/real-compiler tests; it does not make this host a parser, prove that the pinned LLVM binary accepts `.atto`, or claim full numeric/structural/import parity. Exact-head `npm test` is host validation. Only `npm run test:real-compiler` with an independently pinned LLVM binary built from an `.atto`-admitting source commit, and actual isolated guest output, can establish compiler-backed evidence.

Legacy `.ores` source paths continue to work during migration. Package names, npm identifiers, compiler binary name, guest ABI and wire identifiers remain unchanged.