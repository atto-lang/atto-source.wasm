# Experimental Wasmtime strict-AOT host

## Experimental per-tenant Wasmtime Stores

A native tenant compartment prototype now lives in
[`run/src/tenant_isolation.rs`](run/src/tenant_isolation.rs). One tenant
owns one `wasmtime::Store` and one Wasm `Instance` with its own
128-KiB bounded linear memory. A shared `Engine` and compiled `Module`
may be reused across tenants. The debug-only
`--tenant-isolation-smoke` runner path executes a real precompiled
counter guest across two separate Stores and checks lifecycle fencing.

**This is not a production-enabled service or an OS sandbox.** The existing
release-mode deny gate is unchanged. The tenant ID is not a credential;
the deployment broker, authenticated approval and process sandbox are
still required. See [the full contract](../docs/WASMTIME_TENANT_STORES_V0.md).

The Wasm/AOT foundation was merged into `main` through [PR #4](https://github.com/ores-truffle-oreslang/oreslang-source.wasm/pull/4) and [PR #3](https://github.com/ores-truffle-oreslang/oreslang-source.wasm/pull/3).
**This remains an experimental development-only loader, not a production sandbox.** The independent [private Rust AOT verification run](https://github.com/embedded-alerts-test/web-ui-e2e/actions/runs/38755259716) passed its `wasm-aot` job, but [source-repository CI issue #5](https://github.com/ores-truffle-oreslang/oreslang-source.wasm/issues/5) remains unresolved. Neither result authorizes production execution.

The builder uses Wasmtime's Cranelift compilation in a trusted build job;
the runner is a *separately built crate* without Cranelift or Winch features.
Cargo feature unification across the two crates would defeat that design.

Build and run **only in an isolated development environment** with a Rust
toolchain. The caller can choose both the native artifact and its hash; this
debug mode is deliberately insecure and **must not be deployed**:

```sh
cargo build --locked --manifest-path aot-host/precompile/Cargo.toml
cargo build --locked --manifest-path aot-host/run/Cargo.toml --features insecure-dev-caller-pin
SOURCE_PIN="$(sha256sum VERIFIED.wasm | cut -d ' ' -f 1)"
aot-host/precompile/target/debug/oreslang-aot-build VERIFIED.wasm "$SOURCE_PIN" NEW.cwasm
AOT_PIN="$(sha256sum NEW.cwasm | cut -d ' ' -f 1)"
aot-host/run/target/debug/oreslang-aot-run NEW.cwasm "$AOT_PIN"
```

Without the insecure feature, even debug builds refuse execution; all
ordinary release builds refuse execution whether the feature is enabled or
not. An independently authenticated operator approval system is not yet
implemented.

The builder checks zero imports, exactly one exported `main:()->i64`,
and a private bounded exported 2-page memory before precompiling.
Only the explicitly insecure debug runner compares the caller-provided
artifact digest *before* Wasmtime's unsafe `Module::deserialize`, checks
the ABI again and executes with a fuel budget.
It never uses `Module::new` or any runtime Wasm compiler.

**Critical boundary:** An SHA-256 digest is a comparison, not a signature.
It must originate from an authenticated trusted deployment channel,
never beside the blob or from the user submitting the Wasm. Wasmtime's
native serialized artifacts are executable code; arbitrary bytes passed
to `deserialize` can cause native code execution. The supplied pin by
itself cannot distinguish a legitimate release unless its origin is trusted.

**Not production safe yet:** no OS sandbox/process supervisor, independently
authenticated deployment signatures, anti-rollback, reliable native CPU/heap/
process limits, or cross-platform compatibility verification. Separate pinned
Cargo.lock files are committed and the strict AOT smoke passed on a private
runner. These are build/integration checks, not production safety evidence.
Wasm validation in PR #1 must precede building, including denial of
start sections, tables and hidden non-exported memories. A future production runner needs an independently authenticated artifact
approval mechanism, a trusted read-only store and OS process isolation.

Wasmtime versions/configurations/CPU features must match AOT artifacts.
Rust crates use the same exact Wasmtime release but do not share a workspace.
CI must prove compiler features are absent from the runtime dependency graph
and exercise digest tamper/replay, ABI mismatch and fuel exhaustion.

### Strict source admission added

The precompiler now parses the exact input Wasm bytes **before** native
compilation and rejects the presence of any start, import, table, element,
tag, or unknown section. It requires one and only one explicit private wasm32
linear memory with no custom page-size, no shared/memory64 mode, and a maximum
of two pages. This closes gaps left by checking exported Wasmtime metadata
alone: otherwise a hidden internal table/start function/extra memory would
be invisible. The precompiler serializes the single already-validated native
module instead of compiling it again. The source verifier includes unit tests;
the native gates require a Rust toolchain, and remain mandatory on any changed source revision.

### Native file-read boundary

Both native binaries now use a single bounded no-follow, nonblocking file
handle. Symlinks, pipes and sockets are refused before parsing or unsafe AOT
loading; inode identity, length, mtime and ctime are checked around the copy.
Unix is an explicit prototype requirement until equivalent Windows handle
semantics are implemented. The separately provisioned trusted AOT artifact
SHA-256 remains mandatory: file metadata alone does not authenticate content.

### Extended CI admission corpus and toolchain pin

The AOT smoke now generates **valid** core-Wasm binaries that carry an
otherwise forbidden start function, table, imported function or additional
unexported memory. Node's WebAssembly validator first confirms each module
is structurally well-formed. The trusted precompiler must reject each with
no artifact produced, independently of generic Wasm parsing.

The AOT branch pins Rust **1.96.0**, consistent with the minimum toolchain
expected for Wasmtime 49.x. This pin prevents GitHub runner updates from
changing the compiler selected during verification. The feature-graph and
AOT execution checks remain required on every relevant source revision.

### Format discrimination before unsafe AOT deserialization

The runner now applies Wasmtime's safe `Engine::detect_precompiled`
header probe and only admits `Precompiled::Module` before calling unsafe
`Module::deserialize`. This prevents raw Wasm and Wasmtime components from
reaching that call. The smoke test supplies the **correct digest of raw Wasm**
to verify actual format rejection, not merely a mismatched-hash rejection.
The format probe is deliberately **not** an authenticity or safety proof;
only out-of-band approval of trusted serialized module bytes supports the
safety contract for native deserialization.

### Mandatory production fail-closed gate

The only existing approval credential is a SHA-256 passed by the same caller
that supplies the native executable. **That is not an independent trust
anchor.** Until an authenticated approval service, OS process isolation and
privileged deployment configuration exist, `oreslang-aot-run` now **returns
an error unconditionally in release builds before reading an artifact**.
The caller-pin execution path is limited to Rust debug builds strictly for
local compiler-free AOT smoke tests; it is explicitly unsafe for production,
even if an attacker can reproduce its digest. The smoke matrix builds the
release runner separately, supplies a genuinely generated artifact and its
matching hash, and asserts the release binary rejects it for this specific
policy reason. A full production implementation must replace—not bypass—this
gate with an out-of-band signed approval and process isolation.

The native debug executable now also **fails closed by default**. Deliberate
local AOT execution requires all three conditions: Cargo's `debug` build
profile, Rust debug assertions, and the explicit
`--features insecure-dev-caller-pin` flag. A new `build.rs` gate checks the
Cargo build profile independently of `debug_assertions`, which can be forced
on in a release build. That feature never authorizes release-mode execution:
CI builds a release runner **with the feature enabled and release debug
assertions forced on**, then verifies it still refuses a known-good artifact. The test suite first
exercises the default-debug denial before enabling the development feature.

### PR #2 resource and compiler-pinning parity

The trusted precompiler now requires a 64-digit source-Wasm SHA-256 pin as a
separate command-line argument, checks it before compiling, and refuses a
mismatch. This is identity verification, **not proof of release approval**.
Its usage is now:
`oreslang-aot-build VERIFIED.wasm APPROVED_WASM_SHA256 NEW.cwasm`.

The opt-in, debug-only AOT runner now enforces Wasmtime store limits of 128
KiB guest memory, one instance, one memory and zero tables, and a configurable
fuel allowance between 1 and 100,000,000 (default 1,000,000). CI includes a
valid LLVM-generated infinite-loop Wasm module that must fail with limited
fuel rather than completing or timing out. These limits are not OS cgroups,
process memory isolation, native RSS limits or a production approval service.

### Patched Wasmtime runtime pin

Both standalone Cargo graphs now pin the same `wasmtime = "=49.0.3"`
release (October 14, 2026). This is a security-maintenance update from
49.0.1; the upstream 49.0.3 release documents multiple corrected panics,
resource-safety defects, and native runtime vulnerabilities. See
https://github.com/bytecodealliance/wasmtime/releases/tag/v49.0.3 .
Re-run the native build, source admission, serialization compatibility and
compiler-free Cargo tree checks before merging. The runtime remains
**non-production and release-mode disabled** in this PR.

### Atomic, no-overwrite native artifact publication

The precompiler no longer creates the final `.cwasm` and then writes bytes
through a public release pathname. It creates a private, mode-0600 temporary
file **in the destination directory**, writes and `fsync`s the complete AOT
bytes, then publishes using `tempfile::persist_noclobber`; an existing final
artifact (including a pre-existing symlink) is never overwritten. The parent
directory is synced before success is reported. A crash may leave a staging
file, but it cannot expose a partially written final artifact.

The destination directory is a **trusted single-writer build directory**.
Do not place it in a guest-writable or untrusted shared directory. The path
publication protocol is not a signature, deployment approval, or OS sandbox.

### Reproducible, independent Cargo dependency locks

The trusted precompiler and compiler-free runtime now carry separate,
Cargo-generated `Cargo.lock` files resolved by the verified private
Rust 1.96 runner (2026-10-15). The precompiler lock includes
`wasmtime-internal-cranelift` and the runner lock does **not**; both resolve
Wasmtime 49.0.3. CI and native smoke builds use `--locked` to refuse any
unexpected dependency resolution or missing lockfile. Cargo locks are
reproducibility records, not security attestations.

Verified private runner: https://github.com/benefactor-cc/backend.rs/actions/runs/38691712667 .


### Native strict-AOT managed-reference rejection

The **trusted Rust precompiler** now validates the complete Wasm module with
`wasmparser::Validator` configured to reject the GC, GC-types,
reference-types, and typed-function-reference proposals. This validation
happens on the same SHA-256-pinned input byte snapshot before Wasmtime's
`Module::from_binary` and serialization. It complements, but does not
replace, the existing raw section checks and the separate JavaScript
`no-managed-wasm` admission for Node hosts.

Rust regression tests present **otherwise valid Wasm binaries** carrying
an unused `externref` function parameter, a GC `struct` type, a
`ref.null extern` instruction hidden in a function body, an unused SIMD
vector instruction, and a tail-call instruction. Default proposal validation
must accept each binary; the strict AOT precompiler must reject
each. SIMD/relaxed-SIMD, tail calls, threads, exception handling, memory64,
multi-memory and managed reference proposals are disabled by the native
scalar feature profile to match the narrower Node scalar admission. Run with:

```sh
cargo test --locked --manifest-path aot-host/precompile/Cargo.toml
```

This prevents managed Wasm references from entering the native guest profile.
It is **not** a proof of zero allocation or zero GC for the host process, and
it does not authorize production use of native serialized artifacts. Guest
linear-memory reclamation and ownership proofs still require separate
compiler-generated evidence. Browser, Node, and desktop Wasm execution can
share portable ahead-of-time-generated `.wasm` modules, but browser and Node
engines may still JIT or tier them; native Wasmtime `.cwasm` precompiled
artifacts are host/CPU/version-specific and must never be treated as a
portable browser binary.
