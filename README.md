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

## Callable ABI v1 verification boundary (draft)

The proposed owned-callable ABI is tracked in [atto-spec](https://github.com/atto-lang/atto-spec/blob/spec/owned-callable-abi-v1-20261115/language/callable-owned-closure-abi-v1.md) and [issue #12](https://github.com/atto-lang/atto-source.wasm/issues/12). This repository **does not yet contain an independent AttoLang Wasm compiler** and does not emit Atto closure environments or safe callable handles.

The executable regression test can be run with npm test (Node 22). It builds a small native Wasm module using exact binary sections and executes actual WebAssembly **call_indirect**: a matching signature returns 42; an incompatible function type and an out-of-range table index trap. This is a Wasm-engine primitive check, **not** proof that the Rust compiler can compile an escaping Atto lambda, nor a proof of stale-handle validation or browser parity.

Rust compiler integration must implement owned environment creation, generation/owner checks, cleanup, signature-checked typed indirect calls, and the actual .atto factory/higher-order examples before this backend or /play can be marked executable. The compiler's existing guest ABI v2 and the public playground binary pins must remain unchanged until review, executed guest tests and release approval.
