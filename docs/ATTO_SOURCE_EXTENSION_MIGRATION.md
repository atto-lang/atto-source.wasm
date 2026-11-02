# AttoLang source-extension migration for the Wasm bridge

AttoLang `.atto` is the canonical source extension for new source files. The Wasm repository does not maintain a second language parser: it reads a bounded source file and passes it to the externally supplied, digest-pinned `oreslang-llvmc` compiler, then links verified LLVM IR with Clang for the restricted zero-import core-Wasm guest.

## What changed in this PR

- New byte-identical `.atto` twins are staged for the ten mutable `examples/*.ores` fixtures used by the real compiler and AOT verifiers. A host test compares each `.atto` byte buffer to its retained `.ores` source twin.
- The real LLVM-to-Wasm verifier compiles `.atto` entrypoints, examples, positive scalar fixtures and temporary negative source paths.
- The real source-to-AOT verifier compiles the `.atto` example corpus.
- Compiler executable and source attestation use `ATTOLANG_LLVM_COMPILER`, `ATTOLANG_LLVM_COMPILER_SHA256`, and `ATTOLANG_LLVM_SOURCE_SHA` as the canonical names. Existing `ORESLANG_LLVM_*` values remain temporary fallback aliases so existing runner secrets/variables are not broken by code-only renaming.
- The manually dispatched private LLVM workflow still uses its existing `ORESLANG_LLVM_READ_TOKEN` secret and pinned LLVM source commit. The pinned root CLI path is suffix-agnostic: it opens the supplied regular-file path and sends the bytes to the parser, so standalone `.atto` scalar entrypoints do not depend on the separate module-import resolver work. The current Wasm profile rejects source imports; it therefore does not claim `.atto` module-import parity. Keep the compiler source SHA pinned and unchanged until a reviewed backend update is merged; never switch this workflow to an unmerged PR head or change private source authorization.

## Historical evidence retention

The immutable `contracts/scalar/v1` and `contracts/v1/semantics` source paths, JSON manifests and their historical `.ores` file identities remain unchanged. Their manifests and reviewed receipts are path/hash bound. The real guest verifier stages the verified historical scalar bytes into private temporary `.atto` files before invoking the compiler, so the new suffix is exercised without rewriting old evidence. No old receipt is reissued or promoted.

## Scope boundary

This establishes the Wasm bridge's intended `.atto` path handling and authors host/real-compiler tests; it does not make this host a parser or claim full numeric/structural/import parity. The pinned LLVM root CLI does not enforce an extension allowlist, but actual `.atto` guest compilation and execution still require the protected real-compiler workflow. Exact-head `npm test` is host validation. Only `npm run test:real-compiler` with the independently pinned LLVM binary and actual isolated guest output can establish compiler-backed evidence.

Legacy `.ores` source paths continue to work during migration. Package names, npm identifiers, compiler binary name, guest ABI and wire identifiers remain unchanged.