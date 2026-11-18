# atto-source.wasm

WebAssembly backend and worker-based runtime for AttoLang in browsers and server environments.

## Scope

This repository is the AttoLang ecosystem home for:

- Wasm compilation, message-passing actor execution, browser and server-worker integration, and portable wire contracts.
- Compatibility with the [canonical language specification](https://github.com/atto-lang/atto-spec) where applicable.
- Evidence-based tests, benchmark results, and cross-backend conformance reporting.

## Architecture and compatibility

AttoLang is designed around actors, explicit ownership, and portable concurrency semantics. Backend-specific optimizations must not silently change the shared language contract. Runtime capabilities, target restrictions, and unsupported features should be documented explicitly.

## Building and testing

Consult the checked-in source tree and CI workflows for verified commands and supported targets. Add target-specific build instructions and exact-head execution results as they become available; do not treat a passing host-unit test as proof of guest-language conformance.

## Executed Rust/Wasm `trap` conformance

The actual source-to-WebAssembly compiler lives in `atto-lang/atto-source.rs`: it is Rust-authored and can itself run as Wasm. This repository does not yet contain an independent second compiler and does not distribute compiler binaries.

`scripts/verify-trap-wasm.mjs` compiles and executes the **exact** `trap.atto` program from [playground PR #128](https://github.com/atto-lang/atto-lang.github.io/pull/128) against supplied, SHA-256-verified compiler Wasm. Supply the source Git blob SHA-1 to prevent silently testing a different example.

```sh
node scripts/verify-trap-wasm.mjs \
  /private/path/atto_compiler.wasm \
  /path/to/website/play/examples/preview/trap.atto \
  2f66d63632440f3f9d3686546fe79ae7177b953270be911704941ecd3af80cc6 \
  71d22c2365c687fbce044cea7d7d2927c3fb6e86
```

The compiler digest above belongs to the [previously executed private carrier build](https://github.com/scintilla-run/scintilla-e2e/actions/runs/43520455606), **not** the public website. The test requires real generated guest Wasm to print `5`, `id must be nonnegative`, and `an ordinary throw was caught`, in order, then return `7`. It also verifies that checked integer overflow panics bypass `trap` and raw string throws fail the compiler.

Native `attoc`/Wasm byte parity is tested in the Rust compiler's separate conformance suite. This harness verifies actual Wasm guest execution, not an independent Wasm-language compiler, and only runs when an explicitly reviewed artifact is provided.

**Release boundary:** an unpublished compiler candidate must not be copied into public Pages assets or marked executable before independent binary approval, provenance, protection and deployment gates.

## Source-compiled Rust/Wasm diamond-inheritance conformance (candidate only)

The **Atto source compiler** is implemented in `atto-lang/atto-source.rs`, not as a second independent compiler here. Draft [Rust compiler PR #137](https://github.com/atto-lang/atto-source.rs/pull/137) implements a bounded, statically lowered trait/class inheritance subset. A private validation carrier has already built both the native Rust and wasm32 compiler, compared their emitted guest bytes, executed three passing examples (including the exact site preview), and verified nine expected compiler rejections.

This repository provides an **artifact-driven, fail-closed independent check** of the exact [website diamond preview](https://github.com/atto-lang/atto-lang.github.io/pull/130). It does not bundle or distribute an Atto compiler. Before promotion, download an independently reviewed compiler Wasm privately, verify its SHA-256, and invoke:

```sh
node scripts/verify-diamond-wasm.mjs \
  /private/atto_compiler.wasm \
  /local/site/play/examples/preview/diamond-inheritance.atto \
  <approved-compiler-sha256> \
  05814acb37c0335c03294875b870560a2839031d
```

The script validates compiler ABI/imports, exact sample Git blob, generated guest Wasm, expected stdout, and three mutation-based negative checks: unresolved diamond, missing `override`, and signature mismatch. It never fetches binaries or declares compiler disclosure approval. Even passing checks do not authorize publishing a new playground compiler, and the public site sample remains a disabled **syntax preview** until independent release approval and pin update.

## Project status

This README describes the repository's intended responsibilities. Feature support and release readiness must be established from implementation, tests, and CI evidence rather than this description alone.

## Provenance and reconciliation (2026-11-16)

This repository is the **single canonical home** of the AttoLang/Oreslang Wasm
backend. The full Git history of
[ores-truffle-oreslang/oreslang-source.wasm](https://github.com/ores-truffle-oreslang/oreslang-source.wasm)
(`main` at `088c637d72c2041f4a43433705b70e396866e76e`, 1461 commits) was merged
here with `--allow-unrelated-histories`; no commit was rewritten. New Wasm
backend work lands here, not in the Oreslang repository. `.ores` sources and
Oreslang CLI names remain supported for compatibility; `.atto` is canonical.

The browser **compiler** (Rust, built for wasm32) lives in
[atto-lang/atto-source.rs](https://github.com/atto-lang/atto-source.rs); this
repository is the LLVM→clang wasm32 integration, guest admission and host
runtime backend. They must converge on one guest ABI and one conformance
corpus rather than diverge.

---

# Implementation notes (imported from oreslang-source.wasm)

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

## Related repositories

- [AttoLang organization](https://github.com/atto-lang)
- [Language specification](https://github.com/atto-lang/atto-spec)
- [Platform conformance](https://github.com/atto-lang/atto-platform-conformance)
- [Commercial infrastructure](https://github.com/atto-co)

## Repository ownership and contribution routing

**Belongs in this repository:** Wasm-target compiler lowering and ABI definitions, Wasm guest isolation and host-import contracts, portable runtime/actor semantics, and browser-versus-server runtime integration tests.

**Belongs elsewhere:** Rust compiler implementation work owned by atto-source.rs; JS lowering owned by atto-source.js; publishing/vendoring the deployed playground compiler owned by atto-playground.

**Safety and verification boundary:** Wasmtime is a native/server host, not a browser API. A Web Worker can host a tenant Wasm instance, but actor heap/stack isolation inside it must be proven with bounds, ownership, traps, quotas and negative tests.

Keep canonical AttoLang (.atto) semantics consistent with the language specification, while treating Oreslang-named tooling and .ores as compatibility surfaces.

Changes asserting compiler/runtime support must identify the exact source head, target, toolchain, executed positive and negative guest tests, and failure/unsupported status; an empty CI step list is **not executed**. Documentation records responsibility, **not** a claim of feature completion.
