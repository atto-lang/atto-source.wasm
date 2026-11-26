# Checked unwrap v6 candidate gate (Rust compiler Wasm profile)

Requires a reviewed compiler Wasm artifact with source head/tree and build provenance; a caller-supplied digest alone does not authenticate the builder. This is an artifact verifier, not a standalone compiler implementation.

Five exact candidate fixtures from atto-source.rs #331 head `cd764de225ddbe664f9d2242f54bdef23e39353b` are pinned in `src/checked-unwrap-fixtures.mjs`. All expect actual i64 42, panic_code=0 and exact stdout. The two negative sources must fail compilation with zero emitted bytes. This is NOT the complete shared conformance #635, and does not prove public nominal Error identity or task cleanup.

Run:
```sh
node --test tests/checked-unwrap-fixtures.test.mjs
node scripts/verify-trap-result-wasm.mjs /trusted/atto_compiler.wasm \
  tests/fixtures/trap-result-v1/result-existing.atto \
  <reviewed-compiler-sha256> 2d71c15eb4e2f9f5b9bf42b5eef8ce3271d8106e \
  --checked-unwrap-v6
```

The optional mode is separate from legacy v1 arithmetic/throw semantics. Compiler-produced guest execution requires a trusted compiler and external timeout; do not run unknown compiler bytes or use this gate as a sandbox. Host print output and string lengths are bounded, initial panic code and startup output must be clean, and a guarded host callback fault cannot impersonate a Wasm engine panic.

Local receipt: Node v22.16.0, `node --test tests/checked-unwrap-fixtures.test.mjs` **6 passed, 0 failed, 0 skipped**. Git hash-object matched all seven source/test/fixture blobs from head `9e571e13cbb2dfd1741a8ec52dd6d5e48707f69a`. This is host oracle/fixture integrity only. Compiler Wasm artifact not available: actual compiler and guest gate NOT_EXECUTED. No public pin changes.
