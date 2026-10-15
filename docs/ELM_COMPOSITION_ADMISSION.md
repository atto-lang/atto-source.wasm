# Elm-inspired composition and reactive interoperability — Wasm admission

**Draft negative source-admission tests only.** This repo's core-Wasm ABI requires an
already-supported `() -> i64` guest compiled by the native LLVM compiler.
Wasm is not an independent Oreslang frontend. It has no admitted guest
`Option<T>`, `Result<T,E>`, `Future<T>`, `Stream<T>`,
`Observable<T>`, or `Channel<T>` composition today.

The new test corpus verifies canonical `snake_case` names
(`flat_map`, `map_err`, `and_then`, `filter_map`) and denies
implicit raw-channel-to-Observable conversions. With the actual pinned native
compiler available, an executable scalar control is compiled to WebAssembly;
unsupported source must fail with a diagnostic before artifact publication,
leaving previously valid bytes and provenance unchanged.

Do not infer that a `Future` completion is a stream, that `None` means
channel closure, or that an `Observable` has multicast or unbounded
buffering. Subsequent WebAssembly features must specify memory layout, active
variant destruction, bounded worker lifetime, producer cancellation, host
imports, and source provenance before promotion.

See common-source PR #36, LLVM #413, Java #1017, RX #12. Real-compiler
tests **skip when `ORESLANG_LLVM_COMPILER` is absent**, so an ordinary
`npm test` pass cannot be used as proof of native compiler integration.
