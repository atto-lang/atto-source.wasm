# SIMD128 preflight — experimental, no compiler claim

Tracks [#88](https://github.com/ores-truffle-oreslang/oreslang-source.wasm/issues/88)
and [LLVM alias/vector correctness](https://github.com/ores-truffle-oreslang/oreslang-source.llvm/issues/579).

`scripts/simd128-feature.mjs` contains an import-free minimal Wasm module with an
actual SIMD128 `v128.const` instruction. `WebAssembly.validate` probes the local
Node/engine feature; it does not prove that the production target supports it.
`admitSimd128()` models three independent explicit approvals: target profile,
real Oreslang compiler vector lowering, and target engine. There is never an
automatic scalar fallback from an explicitly requested `simd128` build.

```sh
node --test tests/simd128-feature.test.mjs
```

**Missing before enabling in `compile-ores.mjs`:** real admitted typed-array
lowering in LLVM; generated LLVM IR provenance and emit flags; opcode audit
of the linked Wasm module (not naive substring search); correct import/start/
memory budgets and ABI; integer/FP corner cases; unvectorized scalar module
selected only by explicit choice; cross-engine benchmarking on identical
workloads. Passing this *preflight policy test is not a SIMD compiler test*.
