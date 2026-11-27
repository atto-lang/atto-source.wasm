# AttoLang scalar source → Wasmtime native AOT bridge (experimental)

This is a **developer-only**, closed-world compilation adapter.

Provenance on this stacked branch: **11 unchanged upstream Rust/Cargo Git blobs**
plus one `aot-host/precompile/src/wasm_admission.rs` test extension with both
upstream and current Git blob SHAs recorded in
`ci/native-aot/source-provenance.json`. The parent Wasm #1 branch retains
its original 12 exact upstream blobs. The backend
already has a validated strict Wasmtime AOT `main(): i64` ABI, but its
precompiler refuses **every imported function**. The existing LLVM
`--guest-abi=tenant-vm` actor interface imports `spawn/send/stop`; those
imports **cannot** be smuggled through this scalar adapter. Actor/tenant guest
compiler integration requires a separate, explicitly designed ABI.

The Node 22 bridge `tools/atto_scalar_aot.mjs` rejects non-`.atto` inputs and refuses
missing or incorrectly pinned compiler binaries. It invokes a real AttoLang
LLVM compiler in wasm32 mode, captures the compiler's emitted LLVM IR,
links it to a bounded private-memory wasm32 module, then invokes the
existing Wasmtime 49 precompiler's byte-level admission and ABI validation.
Optional execution requires the explicitly insecure **debug-only** AOT
runner and an exact expected scalar return value. No command runs through
a shell, and artifacts are marked as local development proof only.

## Developer smoke when a real LLVM compiler is available

Compile `oreslang-llvmc` from a known exact source SHA and build the Rust
AOT precompiler/runner. Then use **absolute, resolved tool paths**.

```sh
source=fixtures/scalar-seven.atto
compiler=/absolute/exact-source/build/oreslang-llvmc
builder="$(realpath aot-host/precompile/target/debug/oreslang-aot-build)"
runner="$(realpath aot-host/run/target/debug/oreslang-aot-run)"
clang="$(realpath "$(command -v clang)")"
ld="$(realpath "$(command -v wasm-ld)")"
node tools/atto_scalar_aot.mjs "$source" \
  --source-sha256 "$(sha256sum "$source" | cut -d' ' -f1)" \
  --compiler "$compiler" --compiler-sha256 "$(sha256sum "$compiler" | cut -d' ' -f1)" \
  --wasm-clang "$clang" --wasm-clang-sha256 "$(sha256sum "$clang" | cut -d' ' -f1)" \
  --wasm-ld "$ld" --wasm-ld-sha256 "$(sha256sum "$ld" | cut -d' ' -f1)" \
  --precompiler "$builder" --precompiler-sha256 "$(sha256sum "$builder" | cut -d' ' -f1)" \
  --debug-runner "$runner" --debug-runner-sha256 "$(sha256sum "$runner" | cut -d' ' -f1)" \
  --expect-scalar 7 --out /tmp/atto-scalar-aot-test
```

The runner must have been built in the nonproduction debug feature
`insecure-dev-caller-pin`. It is **not** a trusted deployment authority;
SHA-256 supplied by a caller is only an integrity comparison, not
authorization. Negative-path tests use `node --test tests/scalar-bridge-negatives.test.mjs` without Python. The LLVM compiler, Clang, wasm-ld, native precompiler and debug runner now all require explicit independent SHA-256 pins. The temporary compiler process is also trusted code,
not a sandbox for arbitrary tenant-supplied source.

## Hard release conditions

- Executed exact-head CI must build the real `.atto` compiler, not use
  a shell script or C program generating pre-selected LLVM IR.
- The resulting Wasm must pass the existing import-free, one-private-memory,
  2-page max Wasmtime validation (and the exact () → i64 ABI).
- A real debug native guest must output `7`. An artifact build without
  execution reports `PRECOMPILED_ONLY` — never `EXECUTED`.
- The ABI must be extended separately for `define actor`, `spawn`,
  `send`, `stop` and ownership-state handles; until then actor programs
  are **UNSUPPORTED**, not silently reinterpreted as scalar.
- No Epsilon/Java no-GC, LLVM tenant native compiler certification,
  or production hostile-tenant sandbox is implied by this adapter.
