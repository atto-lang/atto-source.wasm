# Oreslang source-to-WebAssembly backend

Dedicated compiler integration and **experimental zero-capability execution host** for Oreslang core Wasm.
Compare with oreslang-source.* repos.

Please keep parity with oreslang-source.java in terms of features and capability. The same guest code that runs on graalvm should compile and execute with gcc/llvm. Do not use python for anything, use Rust instead of python to support the language.

Notes on the compiler and runtime:

* Strive for zero gc. The borrow checker should accomplish this, and having separate heaps/arenas per actor helps reduce gc overhead.
* Borrow checking uses reserved keywords rt copy, rt share, rt take, rt borrow
* Go for full AOT. Some JIT elements are ok, as long as they can be explicitly controlled/governed by user.
* Strive for hard real time not just soft-real time by minimizing JIT (or having JIT switched off for certain paths) and moving towards full AOT.
* Use data-oriented design and data oriented programming - be mindful of using AoS, SoA, AoSoA and SoAoS where possible.
* Use 32 bit pointers instead of 64 bit pointers for allocation/heaps. Having separate heaps per actor helps with this. 32 bit pointers helps us save up to 50% on memory/RAM. The 32 bit pointers should be implemented so that it stays 32 bit even on Arm-64 machines, etc etc.
* OresLang must be built around excellent tree-shaking so we can get final binary executables as small as possible and reduce startup overhead etc.


## Implemented (initial slice)

- Ported the original source-to-Wasm bridge from the private `oreslang-wasm` repo with its atomic publication / input snapshot / exact compiler hashing tests. The compiler is the existing native `oreslang-llvmc`, NOT a new Oreslang parser.
- Build pipeline: `.atto` (canonical) or `.ores` (legacy) source -> externally supplied native LLVM compiler -> LLVM IR -> Clang wasm32 -> verified core `.wasm`.
- Emit SHA-256-based provenance, bounded-memory artifact manifests, and optional atomic release pointers.
- Deny all guest imports, reject start and table sections, bound private linear memory with a required `memory` export, require an exact `main: () -> i64` signature, and optionally pin module SHA-256.
- Run admitted modules in disposable Node worker threads. Validation and JIT compilation occur inside the worker's deadline, with a module-local four-worker admission quota; the worker is terminated before returning. Each invocation gets fresh, private module memory; the host provides **zero Wasm imports**.
- Regression tests use real Clang-generated Wasm. The standalone compiler integration test is explicitly opt-in and requires a real native Oreslang compiler.

## Run locally

Requires Node 22+, Clang with wasm32 support, and wasm-ld / LLD.

~~~sh
npm test
node scripts/compile-ores.mjs --compiler=/absolute/path/to/oreslang-llvmc --source=/absolute/path/to/main.atto --output=/absolute/path/to/guest.wasm
node scripts/run-guest.mjs --wasm=/absolute/path/to/guest.wasm --sha256=EXPECTED_64_HEX_DIGITS
~~~

For real Oreslang compiler integration, use:

~~~sh
ORESLANG_LLVM_COMPILER=/absolute/path/to/oreslang-llvmc npm test
~~~

A fake or stub compiler exercising the linker does **not** count as real Oreslang language parity.

## Tail-call feature admission (M0)

The narrow `core-wasm.i64-v1` host **does not admit** WebAssembly
`return_call` (opcode `0x12`) or `return_call_indirect` (`0x13`).
The instruction scanner rejects these operations **before engine validation or
compilation**, with `WASM_TAIL_CALL_FEATURE_UNSUPPORTED`. Signed LEB immediate
bytes with the same numeric values remain legal because scanning is
opcode-aware. This avoids silently changing semantics between engines with
different tail-call feature support.

This is a fail-closed feature gate, **not** proper source-level TCO or a portable
trampoline. Feature-gated lowering, exact target capability witnesses, dynamic
routine-reentry fencing, and real 100,000-hop guest tests are still required.

## Security boundary and status

**This is not yet an Oreslang actor runtime, a WASI/component-model host, or a production untrusted-code sandbox.**

- Node worker threads and V8 isolates do not provide OS process separation.
- The CLI requires a pinned SHA-256 digest and refuses oversized input before reading or executing it.
- Deadlines are enforced by terminating a worker, not deterministic instruction fuel; cancellation and isolation are not OS guarantees.
- The four-worker quota is module-local, not a process-wide or cross-service tenant quota; a deployment broker must enforce aggregate budgets.
- The Node/V8 host may perform JIT compilation of WebAssembly: this is NOT a strict-no-JIT runtime.
- The current ABI is intentionally limited to a pure `() -> i64` guest. Actors, channels, ownership transfer, await, host I/O, memory64, threads, shared memory, and guest host imports are **not supported**.
- Static `select` is therefore **fail-closed through the pinned LLVM frontend**, for both `{ ... }` and `over ... end` outer delimiters. The real-compiler gate requires the compiler-owned `native async/channel/select boundary unsupported` diagnostic with no LLVM IR, and the Wasm bridge must publish no release pointer for rejected select source. This repository deliberately does not maintain a second Oreslang select parser.
- Compiler executable bytes must be trusted. A SHA-256 pin proves byte identity, not that the binary came from any particular source commit.
- Full strict AOT requires a separate trusted precompilation stage and compatible compiler-free native runtime (planned: Wasmtime host with OS sandbox).

See [isolation and roadmap](docs/ISOLATION.md), [portable guest build](docs/PORTABLE_GUEST_BUILD.md), and [atomic artifact publication](docs/ATOMIC_ARTIFACT_PUBLICATION.md).

Related projects: [Oreslang LLVM compiler](https://github.com/ores-truffle-oreslang/oreslang-source.llvm), [earlier Wasm ABI prototype](https://github.com/ores-truffle-oreslang/oreslang-wasm), [target profiles](https://github.com/ores-truffle-oreslang/oreslang-target-profiles).

See [value-boundary audit and admission tests](docs/VALUE_BOUNDARIES.md) for
aggregate, call, string, conditional and async feature limits.

## Engineering policy: no Python

Python is prohibited in this repository and throughout the `ores-truffle-oreslang` organization for scripts, tests, CI helpers, code generators, analyzers, automation, and host tooling. Existing Python functionality must be migrated to **Rust** without weakening behavior, security checks, fixtures, or test coverage. Do not add `.py`, `.pyi`, `.ipynb`, Python dependency manifests, `python`/`python3` commands, `pip`, `pytest`, `poetry`, `uv`, or `actions/setup-python`. The WebAssembly backend remains its language-specific implementation; the Python-to-Rust mandate applies to Python tooling rather than rewriting the backend itself.

## Strict compiler-pinned scalar parity gate (candidate)

The `tests/cross-backend-checked-i64-scalar.test.mjs` suite exercises
the actual LLVM-to-Wasm compiler and a WebAssembly guest. To prohibit skipped
tests from being treated as parity evidence and to pin compiler provenance:

```sh
export ORESLANG_LLVM_COMPILER=/absolute/path/to/approved/oreslang-llvm
export ORESLANG_LLVM_COMPILER_SHA256="$(sha256sum "$ORESLANG_LLVM_COMPILER" | cut -d' ' -f1)"
export ORESLANG_SCALAR_PARITY_REQUIRED=1
node --test tests/cross-backend-checked-i64-scalar.test.mjs
```

The SHA-256 must be independently reviewed and pinned to the approved compiler
build; computing it immediately before an unreviewed run **alone** does not
establish trusted compiler identity. In strict mode, missing compiler,
missing/malformed digest, executable hash drift, missing guest execution or
incorrect signed-i64 results fail. The local SHA self-test uses a fake binary
only to prove tamper detection and is **not** guest parity evidence. Workflows
with `steps=[]`/zero executed steps remain infrastructure failures.
CPU/GPU execution expressions, nested placement and `nb`/stream parity: see [proposed v1 contract](docs/CPU_GPU_NB_GRAPH_V1.md). This is **not** a claim that the backend executes GPU or streamed source blocks.
## ODB1 scalar-shift Wasm bridge gate (draft)

The canonical OresDB WAL frame encoder uses signed `int >> 8` rather than
`int / 256` (which yields floating point in the Java/Graal reference).
`npm run test:real-odb1-shr8` is a **required, no-skip** test using a pinned
real `oreslang-llvmc` binary, a clean exact LLVM compiler source commit/tree,
Clang wasm32 code generation, atomic artifact provenance, and eight actual
zero-import, `() -> i64` core-Wasm guests through the Node Worker runner.
Three invalid scalar sources must reject without a release.

Set absolute `ORESLANG_LLVM_COMPILER` and `ORESLANG_LLVM_SOURCE_ROOT` and the
lowercase hex `ORESLANG_LLVM_COMPILER_SHA256` (64 chars),
`ORESLANG_LLVM_SOURCE_SHA` and `ORESLANG_LLVM_SOURCE_TREE` (40 chars each).
`npm test` has separate host-only admission checks; those must not count as
real compiler or Wasmtime evidence. The optional test fails nonzero if the
required real compiler or source provenance is missing.

This is *not* an OresDB WAL guest: current Wasm has no `List<int>`, `Result`,
`Frame`, stdout ABI, actor-isolate filesystem capability, fsync, or replay.
Node Worker execution is **not Wasmtime OS isolation or a production tenant
sandbox**. Full source-level ODB1 and durability parity require real
Wasm32/Wasmtime artifacts and guest-to-host capability contracts separately.

## Repository ownership and migration (2026-11-08)

**Current home:** `ores-truffle-oreslang/oreslang-source.wasm`. **Public language:** AttoLang (formerly Oreslang); retain legacy `oreslang-*` commands, packages, dependencies and existing `.ores` fixtures until each replacement is proven.

- **This repository owns:** Source-to-Wasm backend/bridge and standalone Wasm host integration with explicit browser constraints.
- **Out of scope:** Assuming browser Wasmtime support or conflating Wasm guest execution with Web Worker tenancy. Place shared language semantics and portable core/std in canonical `.atto` modules; keep only indispensable compiler, ABI and runtime-host primitives in this backend.
- **Organization boundary:** [`atto-lang`](https://github.com/atto-lang) is for language semantics, compilers, tooling, conformance and ecosystem libraries. [`atto-co`](https://github.com/atto-co) is for independently governed hosted products, deployment control, tenant infrastructure, identity and billing. Existing similarly named `atto-*` projects do not automatically share this repository's Git identity, code or test status.
- **First-stage migration proposal:** approved GitHub ownership transfer of this existing repo, preserving its name, numeric ID and history, to `atto-lang/oreslang-source.wasm`. No direct legacy-org → `atto-co` transfer is authorized; subsequent product carve-outs require new approval.

**Migration instructions (maintainer preflight):** coordinate exact source head and ownership in [issue #26](https://github.com/ores-truffle-oreslang/.github/issues/26), then follow private [runbook draft #25](https://github.com/ores-truffle-oreslang/.github/pull/25). Confirm source/target admins and independent security reviewer, target access and branch/ruleset protection, exact SHA/tree, PRs/releases, Actions, secrets, GitHub Apps, deployments, dependencies and compatibility links before transfer. Do not clone/mirror private source as a shortcut. Verify unchanged numeric ID and code tree after real transfer, restore controls, rerun exact-head CI and capture **nonzero executed steps**. `steps=[]` / `steps=null` is `NOT_EXECUTED`, not test success; host/static checks cannot certify real AttoLang guest execution, AOT or zero-GC. Defer repository/CLI/extension renames to separately reviewed changes.
