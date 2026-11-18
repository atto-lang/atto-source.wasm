# Oreslang Wasm SIMD128 — guarded experiment

Status: **design only**. Current compiler bridge provides a narrow pure `() -> i64` guest; full Oreslang typed vector lowering is not yet implemented.

## Supported starting point
`scripts/compile-ores.mjs` currently bridges a caller-provided, real native `oreslang-llvmc` to Clang/wasm32, with SHA-256 provenance, no-host-import admission, bounded private memory and a disposable Node worker host. SIMD128 optimization must not skip this verifier or introduce host privileges.

## Dependencies
- The LLVM backend proves safe typed contiguous kernels and sound aliasing: https://github.com/ores-truffle-oreslang/oreslang-source.llvm/issues/579
- Frontend and type-system contracts explicitly allow the kernel shape, vector lane width and floating-point behavior.
- Host feature detection and target profile distinguish required SIMD from scalar-only modules.

## Proposed tests
1. Compile **real .ores source** via exact pinned native compiler; preserve source, compiler, LLVM IR and wasm hashes.
2. Prove successful module contains SIMD128 opcodes via an independent Wasm decoder/disassembler; the presence of `-msimd128` does not count.
3. Compare scalar and vector modules on the same engine and workload, including sub-lane tails and unaligned lengths.
4. Reject modules requiring SIMD on an engine lacking SIMD, or explicitly select a prebuilt scalar alternative **before** module admission.
5. Test negative imports/start/table/memory/export/ABI cases against existing host validation.
6. Capture engine version, sandbox/worker caps, repeated throughput, warmup and semantic outputs. Never classify a linker stub as language parity.

## Completion
- [ ] Real compiler supports at least one vectorizable typed kernel
- [ ] Feature-gated emission and independent opcode verification
- [ ] SIMD-disabled negative tests, scalar semantics and existing sandbox regression
- [ ] Measured benefit/regression or explicit `NOT_VECTORIZED`

Tracking: https://github.com/ores-truffle-oreslang/oreslang-source.wasm/issues/88
