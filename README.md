> **AI agent instructions (organization-wide):** Before working on code, issues, or pull requests, read and follow the [organization `AGENTS.md`](https://github.com/atto-lang/.github/blob/main/AGENTS.md), including its **merge-first stealth-development policy**. Honor any repository-local `AGENTS.md`, explicit holds, and GitHub-enforced rules.

# atto-source.wasm
## VM isolate execution architecture

A tenant-scoped `OresVM` worker host now assigns separate handles, quotas and shutdown tracking around the existing disposable-worker `runIsolatedCoreGuest`. Node Workers are **not** an OS-level security sandbox.

See [the shared tenant IsolateVM contract](docs/VM_ISOLATE_CONTRACT.md) for lifecycle, V8 lessons, resource retirement, restrictions and remaining acceptance gates.



WebAssembly backend and worker-based runtime for AttoLang in browsers and server environments. The dotnet runtime will also use wasm to achieve TenantVM isolation.

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

## Canonical AttoLang name and repository migration

This is the canonical home of the AttoLang WebAssembly integration and host runtime. The Git history includes the repository's earlier development; future contributions and links use [atto-source.wasm](https://github.com/atto-lang/atto-source.wasm) and canonical `.atto` source. Update Git remotes to `https://github.com/atto-lang/atto-source.wasm.git`.

**Normative grammar and semantics:** [atto-spec](https://github.com/atto-lang/atto-spec), including the ownership, lifetime, effects, value-equality, bitwise/stream and module-constant contracts. Historical compiler examples do not supersede the current specification. A specification target is not a claim that this backend implements it.

**Responsibility split:** [atto-source.rs](https://github.com/atto-lang/atto-source.rs) contains the Rust-authored browser compiler, including its wasm32 compiler build. This repository handles LLVM-to-Wasm integration, binary admission, guest execution and worker-host constraints. There is no independently implemented second AttoLang source compiler here. Share guest ABI and differential fixtures through [atto-platform-conformance](https://github.com/atto-lang/atto-platform-conformance) and [atto-compilers-parity-testing](https://github.com/atto-lang/atto-compilers-parity-testing).

## LLVM-to-Wasm integration: implemented narrow slice

- A trusted externally supplied LLVM compiler emits IR for the supported AttoLang subset; Clang/LLD generate wasm32 binaries. Never treat a parser substitute or fake linker-only run as AttoLang guest compilation.
- The `core-wasm.i64-v1` admission gate requires no guest imports, no start/table sections, bounded and isolated linear memory, a memory export and the exact `main: () -> i64` signature. Optional module digest checks support artifact pinning; a hash alone does not attest compiler provenance.
- Admitted Wasm executes inside disposable Node workers with bounded deadlines and a module-local admission quota. Validation/JIT compilation occur inside the worker deadline. Workers and V8 isolates are **not** OS process/tenant sandboxes and are **not** a strict-no-JIT runtime.
- Native compiler integration, actor behaviors, channel I/O, async `select`, ownership transfer, WASI and a general host-import ABI remain independently gated. The worker host does not establish cross-backend guest parity by itself.
- Tail-call opcodes `return_call` and `return_call_indirect` are rejected with `WASM_TAIL_CALL_FEATURE_UNSUPPORTED` before engine validation; this is a feature gate, not portable tail-call optimization.
- Preserve fail-closed diagnostics and atomic publication safety: a rejected or unapproved guest must not acquire a release pointer or appear as a verified artifact.

## Local host tests and independently pinned guest tests

Requires Node 22+, Clang with wasm32 target support and LLD for relevant tests.

```sh
npm test
node scripts/run-guest.mjs --wasm=/absolute/path/to/guest.wasm --sha256=EXPECTED_64_HEX_DIGITS
```

For compiler-backed scalar and cross-backend checks, inspect `tests/cross-backend-checked-i64-scalar.test.mjs` and `npm run test:real-odb1-shr8` for the **actual** environment-variable contract implemented by the checked-in scripts. Some integration scripts and env keys still carry migration-era identifiers. Do not invent replacement `ATTO_*` variables or rewrite command examples until the implementation has been updated and tested. The old identifiers are intentionally not promoted as current README interfaces.

The scalar parity gate must receive an independently reviewed compiler executable, pinned SHA-256 digest, clean exact source SHA/tree, real Clang wasm32 build and an executed positive/negative guest suite. The historical WAL/shift gate is a limited scalar fixture, **not** a claim of full guest database I/O, durability or actor filesystem support. `npm test` alone covers host-side admission checks and must not be counted as compiled AttoLang parity evidence.

## Security, tooling and acceptance requirements

- Never publish an unreviewed compiler binary or compiler Wasm to the public playground. Release promotion requires independent approval, exact provenance and protected deployment.
- Use Rust for new test harnesses, analysis and build support rather than Python. Do not remove existing safety checks or fixtures while migrating tooling; language-specific host JavaScript and native LLVM/Clang implementation remain where required.
- Target goals such as near-zero GC, actor-local arenas, data-oriented layouts (AoS/SoA/AoSoA), governed AOT/JIT and strict isolation must be separately measured and proved per target. A disposable worker is not a hard-real-time or zero-GC proof.
- Every claimed compiler or runtime capability requires exact commit/tree, compiler artifact digest, target/toolchain, **executed guest** positives and negatives, and `passed` / `failed` / `unsupported` / `not executed` receipts. An empty CI step list is `not executed`, not a pass.

Read [isolation and roadmap](docs/ISOLATION.md), [portable guest builds](docs/PORTABLE_GUEST_BUILD.md), [atomic artifact publication](docs/ATOMIC_ARTIFACT_PUBLICATION.md), [value boundaries](docs/VALUE_BOUNDARIES.md) and the [CPU/GPU proposal](docs/CPU_GPU_NB_GRAPH_V1.md) for target-specific limitations.

## Related repositories

- [AttoLang organization](https://github.com/atto-lang)
- [Language specification](https://github.com/atto-lang/atto-spec)
- [Platform conformance](https://github.com/atto-lang/atto-platform-conformance)
- [Commercial infrastructure](https://github.com/atto-co)

## Repository ownership and contribution routing

**Belongs in this repository:** Wasm-target compiler lowering and ABI definitions, Wasm guest isolation and host-import contracts, portable runtime/actor semantics, and browser-versus-server runtime integration tests.

**Belongs elsewhere:** Rust compiler implementation work owned by atto-source.rs; JS lowering owned by atto-source.js; publishing/vendoring the deployed playground compiler owned by atto-playground.

**Safety and verification boundary:** Wasmtime is a native/server host, not a browser API. A Web Worker can host a tenant Wasm instance, but actor heap/stack isolation inside it must be proven with bounds, ownership, traps, quotas and negative tests.

Keep current `.atto` semantics aligned with [atto-spec](https://github.com/atto-lang/atto-spec). Implementation gaps must be reported explicitly instead of silently claiming compatibility.

Changes asserting compiler/runtime support must identify the exact source head, target, toolchain, executed positive and negative guest tests, and failure/unsupported status; an empty CI step list is **not executed**. Documentation records responsibility, **not** a claim of feature completion.

## Callable ABI v1 verification boundary (draft)

The proposed owned-callable ABI is tracked in [atto-spec](https://github.com/atto-lang/atto-spec/blob/spec/owned-callable-abi-v1-20261115/language/callable-owned-closure-abi-v1.md) and [issue #12](https://github.com/atto-lang/atto-source.wasm/issues/12). This repository **does not yet contain an independent AttoLang Wasm compiler** and does not emit Atto closure environments or safe callable handles.

The executable regression test can be run with npm test (Node 22). It builds a small native Wasm module using exact binary sections and executes actual WebAssembly **call_indirect**: a matching signature returns 42; an incompatible function type and an out-of-range table index trap. This is a Wasm-engine primitive check, **not** proof that the Rust compiler can compile an escaping Atto lambda, nor a proof of stale-handle validation or browser parity.

Rust compiler integration must implement owned environment creation, generation/owner checks, cleanup, signature-checked typed indirect calls, and the actual .atto factory/higher-order examples before this backend or /play can be marked executable. The compiler's existing guest ABI v2 and the public playground binary pins must remain unchanged until review, executed guest tests and release approval.

## Canonical on-device browser compilation

`src/canonical-browser-compiler.mjs` provides the compiler-ABI bridge to the exact artifact built from `oreslang-source.rs/browser` ([integration #52](https://github.com/ores-truffle-oreslang/oreslang-source.rs/pull/52)). Verify compiler SHA-256 and size first, then `createCompiler(bytes).compile(source)` emits core Wasm in the browser; `compile(source, "javascript")` uses the same checked frontend and emits ESM. This explicitly selected browser path is separate from the existing native LLVM/Clang bridge and its zero-import scalar ABI. It does not relax that older host admission policy.

The canonical compiler emits `atto.browser.guest.v2`: bounded print imports, actor_spawn/send, actor_init/receive and private fixed wasm32 memory. New test-support receipts bind the compiled artifact to canonical source head/tree/path. The focused canonical-browser-compiler tests execute identical source actors as ESM and Wasm, comparing stdout and private instance memory. `browser-tenant-runtime.mjs` is an experimental host for compiler-emitted ESM in a disposable tenant Worker; the parent must enforce its deadline. JS temporaries use engine-managed memory, and Web Workers are not OS isolation. Native LLVM actor syntax/parity and old-host actor admission remain separate incomplete work.

## Tenant Worker scheduling

`runTenantGuest` runs actor instances inside their owning tenant Worker and yields a MessageChannel task between round-robin turns. Every actor has a fresh instance and private non-shared Wasm linear memory. Limits: 16 actors, 10,000 accepted messages per actor, 20,000 aggregate accepted messages, 16 MiB aggregate guest linear memory including main, and 1 MiB per instance. Admission rejects before constructing an actor that would exceed the known per-instance memory budget. The parent Worker owner enforces execution deadline/cancellation; another tenant has its own Worker and continues independently.

`createTurnQueue().yieldTurn()` is the browser carrier primitive for future compiler-lowered Atto Task continuations. It uses MessageChannel rather than nonstandard browser setImmediate or a Promise-only microtask spin. This change supplies scheduling between complete actor turns; source-level `nb`, Task/await, suspended frame ownership and cooperative checkpoints inside a turn still require compiler lowering. The synchronous `runCanonicalGuest` remains available for differential harnesses.
