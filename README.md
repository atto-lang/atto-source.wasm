# Oreslang source-to-WebAssembly backend

Dedicated compiler integration and **experimental zero-capability execution host** for Oreslang core Wasm.

## Implemented (initial slice)

- Ported the original source-to-Wasm bridge from the private `oreslang-wasm` repo with its atomic publication / input snapshot / exact compiler hashing tests. The compiler is the existing native `oreslang-llvmc`, NOT a new Oreslang parser.
- Build pipeline: `.ores` source -> externally supplied native LLVM compiler -> LLVM IR -> Clang wasm32 -> verified core `.wasm`.
- Emit SHA-256-based provenance, bounded-memory artifact manifests, and optional atomic release pointers.
- Deny all guest imports, reject start and table sections, bound private linear memory with a required `memory` export, require an exact `main: () -> i64` signature, and optionally pin module SHA-256.
- Run admitted modules in disposable Node worker threads. Validation and JIT compilation occur inside the worker's deadline, with a module-local four-worker admission quota; the worker is terminated before returning. Each invocation gets fresh, private module memory; the host provides **zero Wasm imports**.
- Regression tests use real Clang-generated Wasm. The standalone compiler integration test is explicitly opt-in and requires a real native Oreslang compiler.

## Run locally

Requires Node 22+, Clang with wasm32 support, and wasm-ld / LLD.

~~~sh
npm test
node scripts/compile-ores.mjs --compiler=/absolute/path/to/oreslang-llvmc --source=/absolute/path/to/main.ores --output=/absolute/path/to/guest.wasm
node scripts/run-guest.mjs --wasm=/absolute/path/to/guest.wasm --sha256=EXPECTED_64_HEX_DIGITS
~~~

For real Oreslang compiler integration, use:

~~~sh
ORESLANG_LLVM_COMPILER=/absolute/path/to/oreslang-llvmc npm test
~~~

A fake or stub compiler exercising the linker does **not** count as real Oreslang language parity.

## Security boundary and status

**This is not yet an Oreslang actor runtime, a WASI/component-model host, or a production untrusted-code sandbox.**

- Node worker threads and V8 isolates do not provide OS process separation.
- The CLI requires a pinned SHA-256 digest and refuses oversized input before reading or executing it.
- Deadlines are enforced by terminating a worker, not deterministic instruction fuel; cancellation and isolation are not OS guarantees.
- The four-worker quota is module-local, not a process-wide or cross-service tenant quota; a deployment broker must enforce aggregate budgets.
- The Node/V8 host may perform JIT compilation of WebAssembly: this is NOT a strict-no-JIT runtime.
- The current ABI is intentionally limited to a pure `() -> i64` guest. Actors, channels, ownership transfer, await, host I/O, memory64, threads, shared memory, and guest host imports are **not supported**.
- Compiler executable bytes must be trusted. A SHA-256 pin proves byte identity, not that the binary came from any particular source commit.
- Full strict AOT requires a separate trusted precompilation stage and compatible compiler-free native runtime (planned: Wasmtime host with OS sandbox).

See [isolation and roadmap](docs/ISOLATION.md), [portable guest build](docs/PORTABLE_GUEST_BUILD.md), and [atomic artifact publication](docs/ATOMIC_ARTIFACT_PUBLICATION.md).

Related projects: [Oreslang LLVM compiler](https://github.com/ores-truffle-oreslang/oreslang-source.llvm), [earlier Wasm ABI prototype](https://github.com/ores-truffle-oreslang/oreslang-wasm), [target profiles](https://github.com/ores-truffle-oreslang/oreslang-target-profiles).

See [value-boundary audit and admission tests](docs/VALUE_BOUNDARIES.md) for
aggregate, call, string, conditional and async feature limits.

CPU/GPU execution expressions, nested placement and `nb`/stream parity: see [proposed v1 contract](docs/CPU_GPU_NB_GRAPH_V1.md). This is **not** a claim that the backend executes GPU or streamed source blocks.
