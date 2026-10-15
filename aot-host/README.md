# Experimental Wasmtime strict-AOT host

Stacked on Oreslang WASM PR #1. **Draft, unbuilt and unverified.**
The builder uses Wasmtime's Cranelift compilation in a trusted build job;
the runner is a *separately built crate* without Cranelift or Winch features.
Cargo feature unification across the two crates would defeat that design.

Build and run with a Rust toolchain:

```sh
cargo build --manifest-path aot-host/precompile/Cargo.toml
cargo build --manifest-path aot-host/run/Cargo.toml
aot-host/precompile/target/debug/oreslang-aot-build VERIFIED.wasm NEW.cwasm
# The expected SHA is provisioned out-of-band through authenticated deployment config:
aot-host/run/target/debug/oreslang-aot-run APPROVED.cwasm TRUSTED_SHA256
```

The builder checks zero imports, exactly one exported `main:()->i64`,
and a private bounded exported 2-page memory before precompiling.
The runner checks the approved artifact digest *before* Wasmtime's unsafe
`Module::deserialize`, checks the ABI again and executes with a fuel budget.
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
