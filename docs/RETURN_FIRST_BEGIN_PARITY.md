# Return-first callable syntax: WASM delegated compiler parity

The WASM runtime does not parse Oreslang source. Source compilation is delegated
to a pinned, independently reviewed native LLVM compiler and wasm32 LLVM IR
lowering through the existing build bridge. No JS source rewriter, regex
transpiler, interpreter fallback or guest import capability is added.

All four spellings are covered by tests/return-first-begin-wasm32-parity.test.mjs:

    int <- main()
    begin
      return 42;
    end.

    int• main()
    begin
      return 42;
    end;

    fnc int <- main()
    begin
      return 42;
    end.

    fnc int• main()
    begin
      return 42;
    end;

## Evidence levels

- Without an externally pinned LLVM compiler, npm tests provide STATIC-ONLY
  fixture checks. Skips are NOT native execution evidence.
- Actual guest parity requires 12 executed zero-import Wasm guests (four headers × three terminators) returning
  42 and 5 real native compiler rejections for malformed declaration syntax.
- Set ORESLANG_RETURN_FIRST_WASM_PARITY_REQUIRED=1 to fail closed if the LLVM
  compiler or exact commit/SHA pin is absent, or if any test is skipped.
- Supply ORESLANG_LLVM_COMPILER (absolute executable path),
  ORESLANG_LLVM_COMPILER_SHA256 (64 lowercase hex),
  ORESLANG_LLVM_SOURCE_SHA (40 lowercase hex), and
  ORESLANG_RETURN_FIRST_WASM_EXPECTED_HEAD (Git HEAD, 40 lowercase hex).
- Run: node --test tests/return-first-begin-wasm32-parity.test.mjs

Full native/actor/method parity is NOT CERTIFIED. The upstream LLVM grammar
is proposed in draft PR #1889, but its compiler binary has not been built,
validated or connected to a passing WASM guest run. Passing an environment
variable named LLVM_SOURCE_SHA is not by itself a provenance attestation:
CI must build the pinned compiler from that exact reviewed source tree, verify
its executable digest, and retain the build receipt. Do not silently rewrite
source to the legacy grammar. Do not export private source to another org
without the independently reviewed carrier/source authorization gates.
