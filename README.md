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

## Project status

This README describes the repository's intended responsibilities. Feature support and release readiness must be established from implementation, tests, and CI evidence rather than this description alone.

## Related repositories

- [AttoLang organization](https://github.com/atto-lang)
- [Language specification](https://github.com/atto-lang/atto-spec)
- [Platform conformance](https://github.com/atto-lang/atto-platform-conformance)
- [Commercial infrastructure](https://github.com/atto-co)

## Repository ownership and contribution routing

**Belongs in this repository:** Wasm-target compiler lowering and ABI definitions, Wasm guest isolation and host-import contracts, portable runtime/actor semantics, and browser-versus-server runtime integration tests.

**Belongs elsewhere:** Rust compiler implementation work owned by atto-source.rs; JS lowering owned by atto-source.js; publishing/vendoring the deployed playground compiler owned by atto-playground.

**Safety and verification boundary:** Wasmtime is a native/server host, not a browser API. A Web Worker can host a tenant Wasm instance, but actor heap/stack isolation inside it must be proven with bounds, ownership, traps, quotas and negative tests.

Keep canonical AttoLang (.atto) semantics consistent with the language specification, while treating Oreslang-named tooling and .ores as compatibility surfaces.

Changes asserting compiler/runtime support must identify the exact source head, target, toolchain, executed positive and negative guest tests, and failure/unsupported status; an empty CI step list is **not executed**. Documentation records responsibility, **not** a claim of feature completion.
