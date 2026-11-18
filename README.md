> **Canonical home moved (2026-11-16):** this compiler now lives in
> [atto-lang/atto-source.wasm](https://github.com/atto-lang/atto-source.wasm) at the repository root (full history),
> merged in atto-lang commit `8bad97834e`. All commits up to `088c637d72`
> are preserved there. **Open new work and pull requests in atto-lang**; open PRs
> here must be re-opened against atto-lang before they can land.

# AttoLang WebAssembly backend (legacy Oreslang checkout)

## AttoLang migration and authoritative specification (2026-11-18)

**AttoLang** (formerly Oreslang) is the current public language name. The AttoLang-named counterpart is [atto-lang/atto-source.wasm](https://github.com/atto-lang/atto-source.wasm); use that repository for new backend work. The source and artifact history of this `ores-truffle-oreslang/oreslang-source.wasm` checkout may not be synchronized with its counterpart. The existing top-of-file notice describes the source-history move. Retain that notice and its exact verified commits; historical commands below refer to this old checkout, not a newly renamed CLI.

**Canonical language rules:** [atto-spec](https://github.com/atto-lang/atto-spec) governs syntax, effects, actors, ownership, diagnostics and target semantics; old README prose and earlier Oreslang-named spec drafts are historical. [atto-platform-conformance](https://github.com/atto-lang/atto-platform-conformance) hosts portable positive/negative guest fixtures, and [atto-compilers-parity-testing](https://github.com/atto-lang/atto-compilers-parity-testing) hosts differential parity work. [atto-common-source](https://github.com/atto-lang/atto-common-source) is for portable `.atto` libraries.

**Current source directives (not automatic backend support):** prefer `.atto` for new portable programs and `snake_case` callable names; explicit ownership uses `borrow!`, `take!`, `share!`, `copy!`, and `copy!!`. [Implicit argument borrowing](https://github.com/atto-lang/atto-spec/blob/main/language/implicit-argument-borrow-v1.md), [file/module constants including one-time non-throwing `os.read_env`](https://github.com/atto-lang/atto-spec/blob/main/language/file-module-const-v1.md), [separate bitwise shifts `<<<`/`>>>`/`ashr` and typed `<<`/`>>` streams](https://github.com/atto-lang/atto-spec/blob/main/language/bitwise-and-stream-operators-v1.md), and [frozen shared ownership](https://github.com/atto-lang/atto-spec/blob/main/language/shared-ownership-and-guards-v1.md) are specified design targets; each backend must independently pass executable admission before claiming support. Preserve existing `.ores`, `oreslang-*` commands, IDs, and ABI/wire spellings until compatibility changes are separately verified.

Do not add Python scripts/tests/CI helpers; Rust is preferred for supporting tooling where practical. A readme rename, an empty `steps=[]` workflow, or a host-only test is not proof of guest-language support, strict AOT, zero GC, OS isolation or cross-backend parity. Document exact compiler/runtime commits, toolchains, actual guest runs and negative rejections with `passed`, `failed`, `unsupported`, or `not executed` results.

Dedicated compiler integration and **experimental zero-capability execution host** for Oreslang core Wasm.
Compare with oreslang-source.* repos.

Target portable compatibility under atto-spec; demonstrate each supported feature by real guest compilation and execution, not by assuming Java/LLVM/Wasm parity. Do not use python for anything, use Rust instead of python to support the language.

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

The historical OresDB WAL fixture uses signed `int >> 8` rather than
`int / 256` (which yields floating point in the Java/Graal reference). This is historical syntax: current AttoLang operator design reserves `>>` for stream reads and spells arithmetic right shift `ashr`. Preserve pinned tests until a compiler-verified fixture migration.
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

## Legacy checkout and contribution routing (2026-11-18)

Use [atto-source.wasm](https://github.com/atto-lang/atto-source.wasm) for new AttoLang work and [atto-spec](https://github.com/atto-lang/atto-spec) for normative changes; preserve this checkout as a historical implementation reference. The existence of a similarly named AttoLang repository does not by itself prove complete Git transfer, issue/PR migration or feature parity. Compare exact Git trees, audit outstanding changes and preserve security controls and execution receipts before declaring migration complete. The older [migration tracker](https://github.com/ores-truffle-oreslang/.github/issues/26) and [review runbook](https://github.com/ores-truffle-oreslang/.github/pull/25) document history, not completion.

