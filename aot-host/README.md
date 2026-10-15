# Experimental Wasmtime strict-AOT host

Stacked on Oreslang WASM PR #1. **Draft, unbuilt and unverified.**
The builder uses Wasmtime's Cranelift compilation in a trusted build job;
the runner is a *separately built crate* without Cranelift or Winch features.
Cargo feature unification across the two crates would defeat that design.

Build and run **only in an isolated development environment** with a Rust
toolchain. The caller can choose both the native artifact and its hash; this
debug mode is deliberately insecure and **must not be deployed**:

```sh
cargo build --manifest-path aot-host/precompile/Cargo.toml
cargo build --manifest-path aot-host/run/Cargo.toml --features insecure-dev-caller-pin
aot-host/precompile/target/debug/oreslang-aot-build VERIFIED.wasm NEW.cwasm
sha256sum NEW.cwasm
aot-host/run/target/debug/oreslang-aot-run NEW.cwasm LOCAL_DEVELOPMENT_SHA256
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

**Not production safe yet:** no OS sandbox/process supervisor, signature
verification, anti-rollback, reliable CPU/heap/process limits, Cargo.lock
files, Rust compiler testing, or cross-platform compatibility verification.
Wasm validation in PR #1 must precede building, including denial of
start sections, tables and hidden non-exported memories. The runner needs a
trusted, read-only artifact store and immutable admission manifest.

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
all native tests still require execution on a real Rust toolchain.

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
AOT execution checks remain required on an actual hosted or trusted runner.

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
local AOT execution requires both a debug build and Cargo's explicit
`--features insecure-dev-caller-pin` flag. That feature never authorizes
release-mode execution: CI builds a release runner **with the feature enabled**
and verifies it still refuses a known-good artifact. The test suite first
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
