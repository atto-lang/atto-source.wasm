# Wasm backend-owned std/path, std/sync, std/telemetry pure policy v1

This draft adds **three backend-local native Atto source modules** in `stdlib/std/`: `path.atto`, `sync.atto`, `telemetry.atto`. They expose 8 lexical path, 11 synchronization admission, and 9 telemetry policy functions. Their sources remain local to this backend; only the behavioral vectors are shared with [atto-platform-conformance](https://github.com/atto-lang/atto-platform-conformance).

The reviewed vector contract is `contracts/atto-std-pure-policy-parity-v1.json`. It contains 134 expected results and 28 typed public API declarations for 11 Atto backends. The copy is Git-blob pinned in `tests/atto-std-pure-policy-source.test.mjs`; drift must be an explicit contract-version change, not a silent API divergence.

## Verification and trust boundary

- `node --test tests/atto-std-pure-policy-source.test.mjs` evaluates the strictly restricted source-only arithmetic/boolean subset and rejects five adversarial changes. This does **not** parse or compile the Atto language with the actual backend compiler.
- The new GitHub Actions workflow checks the exact checkout SHA and source blobs, executes the source subset, and asserts that setting `ATTO_REQUIRE_NATIVE_GUEST=1` fails rather than forging a guest PASS.
- True `std/path` imports and actual guest codegen/runtime execution remain unavailable or unverified until the backend compiler's trusted library resolver and linking stage support these files.
- Path checks are not OS path handles or symlink confinement; sync functions are not actual mutexes, barriers, or semaphores; telemetry functions cannot create an authenticated trace context, patch AOT code, or export network spans.
- No cross-org source transfer is authorized by the source-main private CI allowlist. A source-free carrier with real executed steps plus independent exact immutable destination approval must precede any private mirror.

## Promotion gate

Keep this PR draft. Require a native backend guest fixture with imported trusted `std/path`, `std/sync`, `std/telemetry` modules, exact source/tree SHA, positive and negative behavior vectors, a stepful runner execution receipt, and independent review. A Node source-model pass or queued/zero-step GitHub Action must never count as parity.

## Executable import-denial gate and future 134-vector guest

- `tests/atto-std-import-admission.test.mjs` enters the actual `compileOresToWasm` publication bridge with 10 unlinked `std/*` import variants. An intentionally non-executable compiler file proves rejection occurs before compiler invocation. No Wasm output, provenance sidecar, or scratch compilation directory may appear. Five comment/string-like controls and malformed-source negatives exercise the scanner.
- The exact-head workflow requires that Node bridge test in addition to the independent 134-vector source model.
- `tests/fixtures/atto_std_pure_policy_guest_v1.atto` is the future complete 134-vector compiled Wasm guest. The Node source-only checker verifies all calls and sequential nonzero failure exits against the pinned contract, with one terminal `return 0`.
- Until the Wasm bridge has a trusted, fully snapshotted std module-graph resolver, it must **reject** these imports; a source-model PASS is **not** a real Wasm guest PASS. This full guest fixture remains NOT_EXECUTED.
