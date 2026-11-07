# Typed bool → Wasm32 parity (candidate)

The native LLVM boolean suite at oreslang-source.llvm/tests/native_bool_types.py
includes source programs also executed against Java. This Wasm slice uses
byte-identical bodies for four positive and five negative cases. The two
additional branch programs return 37 and 13 rather than 42.

The 11 canonical .atto files under tests/fixtures/boolean-v1/ are pinned to
their exact Git blob IDs in tests/boolean-source-parity-wasm32.test.mjs.
Source-only tests establish fixture integrity, not backend execution.

Use a reviewed and already authorized local native LLVM compiler:

    ORESLANG_BOOL_WASM_PARITY_REQUIRED=1 \
    ORESLANG_LLVM_COMPILER=/absolute/path/to/oreslang-llvmc \
    ORESLANG_LLVM_COMPILER_SHA256=<64-hex-digest> \
    ORESLANG_LLVM_SOURCE_SHA=<40-hex-commit> \
    node --test tests/boolean-source-parity-wasm32.test.mjs

Strict mode fails when compiler identity is missing. A configured run
must execute all six zero-import isolated Wasm guests, assert exact signed-i64
values, and require five native frontend type diagnostics with no LLVM IR or
artifact publication. Wasm execution is NOT_EXECUTED until an exact-head
stepful run records this suite with an independently authenticated binary.

The LLVM source SHA is supplied metadata, not proof of how the binary was
built. Java runtime parity requires its own pinned executed evidence.
This patch does not enable actors, heap borrowing, async/await, or strict
AOT; the current i64 entry profile remains narrow. Keep the PR draft until
independent review and actual compiler-backed guest execution pass.
