# atto-source.wasm

WebAssembly backend and worker-based runtime for AttoLang in browsers and server environments.

## Scope

This repository is the AttoLang ecosystem home for:

- Wasm compilation, message-passing actor execution, browser and server-worker integration, and portable wire contracts.
- Compatibility with the [canonical language specification](https://github.com/atto-lang/atto-spec) where applicable.
- Evidence-based tests, benchmark results, and cross-backend conformance reporting.

## Architecture and compatibility

AttoLang is designed around actors, explicit ownership, and portable concurrency semantics. Backend-specific optimizations must not silently change the shared language contract. Runtime capabilities, target restrictions, and unsupported features should be documented explicitly.

## Building and testing

Consult the checked-in source tree and CI workflows for verified commands and supported targets. Add target-specific build instructions and exact-head execution results as they become available; do not treat a passing host-unit test as proof of guest-language conformance.

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

## Related repositories

- [AttoLang organization](https://github.com/atto-lang)
- [Language specification](https://github.com/atto-lang/atto-spec)
- [Platform conformance](https://github.com/atto-lang/atto-platform-conformance)
- [Commercial infrastructure](https://github.com/atto-co)
