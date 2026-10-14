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
