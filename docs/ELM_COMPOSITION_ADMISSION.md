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

## Postfix question mark and typed exceptional control (2026-10-15 hardening)

The source admission corpus now covers eleven cases including postfix
`Result?`, postfix `Option?`, proposed `throws E` conversion inside
`try/catch`, `raise` bypassing local catch, and `panic` escalation.
They remain **negative acceptance gates**: a diagnostic/no output is not
executable evidence of return, throw, recover or supervisor correctness.

See common-source PR #36 (postfix `?` routing contract) together with
common-source #35 (callable `throws`/`raises`/`panics` proposal).
`Result<T,E>?` in a `Result<U,E>` callable returns `Err`, even when
`throws E` is also declared. Only a compatible non-Result callable
explicitly declaring `throws E` may convert an `Err` to an ordinary
`throw`. `Option<T>?` can return `None` only from an
`Option<U>` callable; it cannot fabricate an exception. Ordinary
`try/catch` handles real `throw` only, not `Err` returns.
`raise`, `panic`, cancellation, and fatal controls are not caught by
`?` or converted to stream completion.

Release requires native guest-source lowering, typed effect and ownership
verification, exactly-once LIFO cleanup across early return and exceptional
unwind, cancellation/continuation and supervisor integration, plus verified
matching traces against Java/Graal. Do not promote the current negative tests
to positive execution tests without those proofs.
