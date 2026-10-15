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
