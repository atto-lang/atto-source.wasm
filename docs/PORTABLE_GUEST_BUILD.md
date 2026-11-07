# Opt-in portable Wasm guest build

The experimental compiler branch adds `oreslang-llvmc --target=wasm32`. To build a pinned core-i64 guest artifact:

    node scripts/compile-ores.mjs --compiler=/absolute/oreslang-llvmc --source=/absolute/main.ores --output=/absolute/guest.wasm --environment=browser

The compiler stdout must contain a wasm32-unknown-unknown target triple; the bridge links with Clang, verifies the core Wasm module and rejects host imports. It writes guest.wasm.artifact.json (versioned schema in oreslang-target-profiles) with an exact binary digest and bounded memory, plus guest.wasm.provenance.json. This is a pure, scalar-only ABI; it is not a source effect proof, shared MIR, WIT component or public stable compilation command. The compiler option is still a proposed PR until merged.

## Bounded compiler and artifact reads

Inputs are checked by descriptor, not by a separate `stat` followed by
`readFile(path)`. The bridge uses nonblocking no-follow file opens, rejects
symlinks and special files, verifies initial and final inode/size/mtime,
and enforces limits **before allocation**: 1 MiB of Oreslang source, 256 MiB
of compiler executable and 16 MiB of linked Wasm. Its metadata reads remain
independently integrity-checked by the atomic release reader.

These controls provide fail-closed filesystem input admission and snapshot
integrity; they do not sandbox an intentionally malicious native compiler.

## Opt-in scalar f64 guest profile (experimental)

The default stays `core-wasm.i64-v1` with the exact `() -> i64` entry. To
exercise LLVM's emerging binary64 source lowering, opt in explicitly:

    node scripts/compile-ores.mjs --compiler=/absolute/oreslang-llvmc --source=/absolute/main.atto --output=/absolute/float.wasm --profile=core-wasm.f64-v1 --environment=browser
    node scripts/run-guest.mjs --wasm=/absolute/float.wasm --sha256=PINNED_64_HEX --profile=core-wasm.f64-v1

The f64 profile requires an exact `() -> f64` export and retains the same
no-import, no-table, no-start, bounded-private-memory and disposable-Worker
requirements. It admits scalar f64 results only; no parameters, host I/O,
actors, vectors, Decimal, BigInt or nan-bit-payload canonicalization. CLI
results are strings to preserve `-0`, `NaN` and infinities. This does **not**
change the separate native Wasmtime/AOT runner's ABI, grant host capabilities,
or establish Java/LLVM/AttoLang source parity by itself.

`tests/wasm-f64-profile.test.mjs` uses real Clang-linked Wasm to prove the
Node core-Wasm host path. The separately gated
`tests/f64-atto-compiler-parity.test.mjs` only counts compiler-backed guest
execution when a pinned real LLVM compiler binary and exact source SHA are
supplied. An absent toolchain is **NOT_EXECUTED**, not a pass. Independent Java
and native LLVM guest receipts remain required for cross-backend certification.

## Core-only compiler and exact LLVM entry guard

The source bridge now invokes `--library-profile=core --tree-shake
--tree-shake-root=main --target=wasm32` for both scalar ABIs. Only the
`main` root is admitted. The pre-link checker requires exactly one
line-leading `define i64 @main()` or `define double @main()` and rejects
comments, metadata, quoted symbols, and duplicates. The post-link Wasm
validator still enforces the exact signature and zero imports.

Bridge shell stubs are not real AttoLang source execution evidence.
The LLVM float draft #1517 disallows f64 `main` and has unresolved
numeric semantics; compiler-backed f64 source parity remains
**NOT_EXECUTED / NOT_CERTIFIED** pending a reviewed Wasm-specific entry ABI.
