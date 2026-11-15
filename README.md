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

## Executed Rust/Wasm `trap` conformance

The actual source-to-WebAssembly compiler lives in `atto-lang/atto-source.rs`: it is Rust-authored and can itself run as Wasm. This repository does not yet contain an independent second compiler and does not distribute compiler binaries.

`scripts/verify-trap-wasm.mjs` compiles and executes the **exact** `trap.atto` program from [playground PR #128](https://github.com/atto-lang/atto-lang.github.io/pull/128) against supplied, SHA-256-verified compiler Wasm. Supply the source Git blob SHA-1 to prevent silently testing a different example.

```sh
node scripts/verify-trap-wasm.mjs \
  /private/path/atto_compiler.wasm \
  /path/to/website/play/examples/preview/trap.atto \
  2f66d63632440f3f9d3686546fe79ae7177b953270be911704941ecd3af80cc6 \
  71d22c2365c687fbce044cea7d7d2927c3fb6e86
```

The compiler digest above belongs to the [previously executed private carrier build](https://github.com/scintilla-run/scintilla-e2e/actions/runs/43520455606), **not** the public website. The test requires real generated guest Wasm to print `5`, `id must be nonnegative`, and `an ordinary throw was caught`, in order, then return `7`. It also verifies that checked integer overflow panics bypass `trap` and raw string throws fail the compiler.

Native `attoc`/Wasm byte parity is tested in the Rust compiler's separate conformance suite. This harness verifies actual Wasm guest execution, not an independent Wasm-language compiler, and only runs when an explicitly reviewed artifact is provided.

**Release boundary:** an unpublished compiler candidate must not be copied into public Pages assets or marked executable before independent binary approval, provenance, protection and deployment gates.

## Project status

This README describes the repository's intended responsibilities. Feature support and release readiness must be established from implementation, tests, and CI evidence rather than this description alone.

## Related repositories

- [AttoLang organization](https://github.com/atto-lang)
- [Language specification](https://github.com/atto-lang/atto-spec)
- [Platform conformance](https://github.com/atto-lang/atto-platform-conformance)
- [Commercial infrastructure](https://github.com/atto-co)
