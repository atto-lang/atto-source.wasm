# Wasm actor-shard hot-path allocation audit

Status: **host-side actor-memory optimization** stacked on mixed-width draft #113; not source-compiled wasm guest execution.

Previously every `ActorMixedShard.read/write` built a frozen diagnostic address object and a fresh 1/4/8-byte `TypedArray.subarray` view, even inside the integration loop. Both operations add avoidable host allocation pressure and are inappropriate for predictable actor-local data-oriented kernels.

This branch shares the checked `MixedLayoutGeometry.offsetAt()` implementation with JS. Numeric segment coordinates are published only after BigInt quota admission ensures all physical offsets are below 256 MiB; this shard further caps physical allocation to 64 KiB. Every memory operation still passes an authorized actor turn and generation-checked handle to `ActorArena`.

The shard caches one 8-byte scratch buffer and one each of its 1-byte, 4-byte, and 8-byte views. Its scalar methods reuse those views without generating a new `subarray`. Cold public `address()` remains frozen for diagnostics, but the hot path calls only `offsetAt()`. Native arena internals remain separately responsible for ensuring borrow/lifetime/synchronization safety.

**Evidence:** exact JS geometry and shard source executed in isolated V8 with a bounded fake arena, 32 focused checks passed across the four layouts, stale/foreign turn rejection and a hot-path canary forbidding temporary array views/address freezing. This is **not** a real WebAssembly.Memory run, LLVM-to-Wasm code, or a production guest benchmark.

**Gates:** execute Node tests with real `WebAssembly.Memory`, run browser/Wasmtime conformance, prove allocation behavior using runtime tracing, and compile/execute emitted Oreslang mixed-width guest programs with actor-owned lifetime proofs.
