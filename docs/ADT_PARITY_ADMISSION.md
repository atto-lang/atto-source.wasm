# ADT parity admission boundary — November 1, 2026

The current Wasm bridge is scalar only. It does not implement nominal
user-defined enums, type-only match-pattern domains, typed Option/Result
payloads, exhaustive tagged matching or actor-wire ADT encoding.

The new lexer-backed `rejectUnsupportedAdtSource` executes on pinned,
bounded source bytes **before** invoking the LLVM compiler or publishing
a Wasm artifact. It distinguishes comments and strings from source tokens.
Its 24 tests are source admission only, never guest execution evidence.

Target source semantics are pinned in the 36-case conformance manifest
in `oreslang-platform-conformance` PR #270. All backend confirmations
remain empty. Actual parity needs exact-head LLVM frontend lowering,
Wasm type/ownership/ABI representation, compiled guest execution, true
semantic negative diagnostics, Wasmtime-isolate acceptance and review.
Unsupported-syntax errors or zero-step CI cannot count as passes.
