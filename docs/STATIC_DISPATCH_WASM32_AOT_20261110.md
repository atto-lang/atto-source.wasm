# Wasm32 compiled direct-dispatch admission, v1

Status: **compiler-backed test proposal**; not a claim of executed Wasm or
full NativeAOT parity until actual pinned-compiler CI receipts exist.

## Scope

The Wasm adapter delegates `.atto` parsing and class-method lowering to an
LLVM compiler binary. The first bounded class subset has a fully precompiled
module with two statically selected overload slots:

- `Box.read$arity0` (zero source arguments)
- `Box.read$arity1` (one source argument)

`tests/static-dispatch-llvm-wasm32-aot.test.mjs` requires both **exact
direct LLVM call-site targets**, not merely declarations or string mentions;
compiles the real LLVM IR to a `wasm32` module via Clang, instantiates that
module in the Wasm runtime, and checks `main(): i64 == 42`. The generated
module must not import runtime host functions. A duplicate method slot must
be rejected by the source compiler before any LLVM IR emission.

The test includes independent source-only mutation checks for forged
comment/declaration symbols, overload-slot lookalikes and indirect LLVM
function-pointer calls.

## Required execution

The source repository does not embed a private LLVM compiler or download
a binary with cross-org credentials. Run the fail-closed command only when
a source-authorized compiler artifact has been built on the *exact* LLVM
PR head and its SHA256 has been verified:

```sh
ORESLANG_LLVM_COMPILER=/absolute/path/to/oreslang-llvmc \
ORESLANG_LLVM_COMPILER_SHA256=<verified-64-digit-sha256> \
ORESLANG_LLVM_SOURCE_SHA=<actual-40-digit-commit> \
CLANG=/usr/bin/clang-19 \
npm run test:static-dispatch-wasm32
```

When these values are not present, the ordinary `npm test` run skips
the real guest test; a skipped test **cannot** count as conformance.
`ATTO_WASM_STATIC_AOT_REQUIRED=1` must turn missing evidence into failure.

## Evidence and parity restrictions

- The source compiler emits LLVM IR; Clang emits a real wasm32 program image.
  The guest executes via `WebAssembly.Module`, **not** a Node reference
  interpreter or untrusted runtime source compiler.
- A Wasm engine may JIT-compile module bytecode internally; this proves a
  **precompiled guest Wasm module**, not host-native ahead-of-time machine code
  or an audited Wasmtime precompile/deploy chain.
- This test does not establish other Java, .NET, Forge, inheritance,
  generic/trait witness, actor or macro-generated dispatch paths.
- For the full strict-AOT release profile, separately run the Wasmtime
  precompile/deserialize artifact gate with a pinned host binary, closed
  table/import/tenant limits and source-tree evidence.
- Avoid public mirrors of private AttoLang source. When CI minutes are
  exhausted, use a private authorized test repository, exact Git blobs/tree
  and its own local checkout token with nonzero job steps.
