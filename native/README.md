# Wasmtime AOT implementation (experimental)

This implements a trusted native compiler and a **separate compiler-free** Wasmtime runtime.

- `native/aot-builder` pins Wasmtime 49.0.3 with Cranelift. It verifies the source Wasm SHA-256 supplied by an approved build pipeline, validates the scalar profile (no imports/start/table, one bounded 2-page memory), then precompiles with fuel instrumentation into an output that cannot overwrite an existing path.
- `native/aot-runner` pins the same Wasmtime version and only `std,runtime` features (no Cranelift/Winch). It has no `Module::new` and never compiles raw Wasm at runtime; it only uses `Module::deserialize` after checking the **approved native artifact hash**. It denies imports and unexpected exports, calls `main: () -> i64`, and enforces per-store 128-KiB linear memory, one instance, one memory, zero tables, and a 1..100000000 fuel budget.
- Both use identical engine configuration. Build these **two independent Cargo manifests separately**; do not unify features in one workspace.

```sh
cargo build --release --manifest-path native/aot-builder/Cargo.toml
cargo build --release --manifest-path native/aot-runner/Cargo.toml
native/aot-builder/target/release/oreslang-wasm-aot-build /trusted/guest.wasm APPROVED_SOURCE_WASM_SHA /trusted/guest.cwasm
native/aot-runner/target/release/oreslang-wasm-aot-run /trusted/guest.cwasm APPROVED_AOT_SHA 1000000
```

**Critical security limitation:** Wasmtime's `Module::deserialize` is unsafe on attacker-supplied native artifacts. A digest supplied by the same attacker **does not** authenticate an artifact. The executor must receive its expected digest from an independently trusted, approved deployment manifest, after a trusted Wasmtime precompilation. The builder and runner must operate on private, non-mutating files. Production service isolation still requires a separate OS sandbox, resource cgroups/job objects and a watchdog. This code is **not** an actor runtime or a multi-tenant security boundary.

**Unverified:** This environment has no Rust/Cargo, so there has been no Rust compile or executable smoke test. Lockfiles, pinned transitive dependency graph, CI and host sandboxing remain required before merge.
