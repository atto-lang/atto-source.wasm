# Verified local inverted rows → wasm32 i64 guest (experimental v0)

**Status: draft implementation, not a passing end-to-end result.**
The real native LLVM frontend now has a separate proposed change admitting
`--target=wasm32` for an *already parser/type/MIR verified* standalone
`InvertedArray<Row>` main with precisely two signed-i64 columns and a
stack-local owner, capacity 1..256 and bounded literal operations.

This WASM bridge preserves its **default fail-closed** inverted-layout
preflight. Opt-in uses `experimentalInvertedI64:true`, requires a real pinned
compiler binary SHA-256, canonical `.atto` input and exact `main` entry.
It sends that immutable source snapshot to the same compiler; no JavaScript
SoA interpreter or host-array emulation is introduced. The opt-in skips
generic tree-shake CLI options **only** because the compiler's verified
inverted program has its own stricter one-local-main closed-world gate.

Example from a controlled, approved compiler build:

```sh
export ORESLANG_LLVM_COMPILER=/absolute/path/to/oreslang-llvmc
export ORESLANG_LLVM_COMPILER_SHA256=YOUR_APPROVED_COMPILER_SHA256
export ORESLANG_LLVM_SOURCE_SHA=YOUR_EXACT_REVIEWED_40_CHAR_SOURCE_HEAD
npm run test:real-inverted-wasm32
```

The integration tests verify exact cross-repo Git blob identities for three
`.atto` fixtures. They compile actual source through native LLVM to
`wasm32-unknown-unknown`, Clang/LLD to a zero-import, two-page core Wasm
module, then execute direct WebAssembly and SHA-pinned isolated Node Worker
guests. Expected results: 42; 4294967338 (proves full signed-i64 ABI); and
a WebAssembly bounds trap after dense swap-erase. A negative inverted class
must reject in the *native frontend* with no executable or metadata
publication.

**Admitted v0 scope is strictly smaller than the target DOP design.**
No inverted class, generic row schemas, actor-owned arena, stable generational
RowHandle, cross-actor transfer, async/yield, suspended borrow or host I/O.
Dense indices are **not** stable handles. This compiler emits bounded
stack-local physical columns, traps on invalid reads, explicitly scrubs owner
storage on the successful exit, and does not emit guest tracing-GC calls.
Host Node/V8 may use tracing GC and WebAssembly JIT. A generated `.wasm`
module is a portable compilation result, **not** a Wasmtime `.cwasm`
precompiled artifact, nor a hard-real-time/process-zero-GC proof.

Review gates: actual stepful LLVM exact-head build and compiler hash, native
O0/O2 plus browser Worker results, guest hash/provenance, no emitted guest
on invalid input, and independently reviewed source-to-compiler provenance.
Missing LLVM compiler, cancelled GitHub Actions, zero-step workflow, skipped
optional test, or self-computed compiler hash alone: **NOT_EXECUTED** for
cross-backend parity. Do not merge into the production-approved profile
until these gates pass.
