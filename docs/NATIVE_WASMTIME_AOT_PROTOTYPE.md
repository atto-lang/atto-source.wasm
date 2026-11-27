# Experimental native Wasmtime tenant AOT prototype

Status: **DEVELOPMENT ONLY**. The native AOT runtime already exists on current AttoLang main. This reconciled PR adds the seed provenance and executable smoke runner without reverting subsequent Rust safety hardening. It carries historical migration context from
`ores-truffle-oreslang/oreslang-source.wasm` PR #403, stacked on PR #173,
at Git head `78b2a80203a3e0a977c4e75479b6c5c672904c42`.

## Scope and provenance

The 12 historical Rust/Cargo seed blobs are recorded in
`ci/native-aot/source-provenance.json`, separately from the corresponding
12 current-main native AOT blob SHA values. Three of the original files were
superseded by later mainline hardening; this PR does not restore old code.
The CI runner checks exact current source blob SHAs before compiling. The migration does not copy a full
Wasm compiler, original JS worker runtime, or original source-org CI tree.

The prototype has a Wasmtime 49.0.3 **compiler-free** AOT runner and
an offline precompiler. Each native guest tenant is admitted to its own
Store/Instance with a bounded, import-free wasm32 linear memory, bounded fuel,
incarnation-fenced host handles and per-tenant teardown. Development smokes
compile real C/LLVM-generated Wasm, precompile it, then test distinct Store
memory and retirement after a genuine infinite loop exhausts fuel.

**No actual AttoLang source compiler is yet integrated in this migration
subset.** A successful smoke here is not a compiled `.atto` guest.

## Security defaults

The runtime executable's default entry point fails closed. There is no
production AOT execution API. The feature `insecure-dev-caller-pin`
allows running precompiled files selected by a caller-supplied SHA-256 only in
a debug build for isolated test execution. Such a hash is **not deployment
authorization**. Release builds remain disabled.

No host imports are permitted by the scalar module profile. Per-tenant Store
and fuel limits do **not** prove process-level memory/CPU sandboxing or
protection against compromised Wasmtime code, native pointers, unsafe FFI or
host kernel vulnerabilities. A future production service needs an
authenticated artifact approval system and OS-enforced supervision/isolation.

## Running the focused executed checks

On a Linux runner with Rust 1.96, Clang wasm32, wasm-ld and Node 22:

```sh
bash ci/native-aot/verify.sh
```

The script first runs six Node-only provenance regression tests (exact 12 Git
blobs, tamper rejection, manifest shape, symlinks and malformed origin) before
running Cargo. A passing Node test is **not** native Wasmtime execution proof.
The script checks Git source provenance, Rust unit tests, default execution
denial, distinct native guest Store memory, a fuel-exhausted spinning guest,
surviving neighbor, fresh reincarnation and an incorrect development digest.

All newly produced evidence is scoped to the **experimental Wasmtime runtime
subset**. Five-backend parity, GraalVM Native Image Epsilon, LLVM native
zero-GC and hostile AttoLang guest security are independent release gates.
