# AttoLang explicit `new` class construction — Wasm executable parity gate

**Status:** authored compiler-backed acceptance gate, **not yet executed or certified**. Stacked on Wasm [#409](https://github.com/ores-truffle-oreslang/oreslang-source.wasm/pull/409), which depends on #406 → #405 → #402.

## Contract / provenance

The new canonical source `contracts/class-new-v1/class-scalar-constructor.atto` contains exactly the bytes of existing native-LLVM-backed `examples/class-scalar-constructor.ores` (shared Git blob `095fb5a5abe828f83facf9688819fe6c2e401aaa`).

The example defines `Pair` with a parameterized constructor; with `new Pair(start)`, its field values are `start + 1` and `start * 2` and `main` returns their sum. It tests an actual **class instance** and field access, not simply a scalar function with the same result.

The canonical fixture is Wasm-local until Java and LLVM independently pin that `.atto` blob in their respective conformance suites. The earlier legacy `.ores` byte identity is a language-source compatibility check, not independent Java execution.

## Required real compiler / guest results

`tests/class-new-v1-native-wasm-guest.test.mjs` requires:

| Case | Source expression | Expected real Wasm main result |
| --- | --- | --- |
| canonical | `new Pair(13)` | 40 |
| zero-input | `new Pair(0)` | 1 |
| twenty-one | `new Pair(21)` | 64 |
| forty-one | `new Pair(41)` | 124 |

The three mandatory compiler-rejected cases are `Pair(13)` (implicit construction forbidden), `new Pair()` (missing constructor argument) and `new Pair(13, 2)` (extra argument). Rejections must be compiler-owned diagnosed exits, no partial LLVM IR, and no Wasm/pointer/manifest publication. The implicit-construction rejection must mention class/construction or an unknown function `Pair`; arity rejections must mention constructor, arity or arguments.

All positives require independently pinned native LLVM compiler executable bytes, original source SHA and guest Wasm SHA, atomic publication manifest, wasm32 target, exactly two bounded memory pages, zero host imports/capabilities, and actual `runIsolatedCoreGuest` result. The source is never evaluated in JavaScript.

## How to execute

After separate authorizations for compiler-source access, verified LLVM source/tree and protected Wasm workflow source:

```sh
ATTO_REQUIRE_CLASS_NEW_WASM_GUEST=1 \
ORESLANG_LLVM_COMPILER=/absolute/path/to/oreslang-llvmc \
ORESLANG_LLVM_COMPILER_SHA256=actual_64_lowercase_hex_sha256 \
ORESLANG_LLVM_SOURCE_SHA=independently_reviewed_40_hex_head \
node --test tests/class-new-v1-native-wasm-guest.test.mjs
```

The protected-main-only manual workflow `.github/workflows/atto-library-core-real-llvm.yml` requires **3 passed, 0 skipped Node tests, 4 compiled guest witnesses and 3 native rejection witnesses**, and uploads `atto-class-new-real-guest.log`. Every fixture and legacy source is checked with Git blob identity. The compiled LLVM bridge remains Core-only, with no generic dynamic host imports.

## Limitations and follow-ups

- The real compiler may still fail these checks. Preserve exact failures as parity gaps; do not change expected values to fit a broken compiler or silently allow bare `Pair()`.
- This is source-level class construction and a single scalar `() -> i64` Wasm entry. It **does not** prove owned actor heaps, separate actor stacks, mutable class lifetime, cross-actor transfers, recursion, suspension or AOT-only execution.
- Java and LLVM also need **their own** executed fixture receipts. A Wasm compiled result alone is not three-backend parity.
- `steps=null` / `steps=[]` indicate runner admission failure, not a class language result.
- No private source should be mirrored to another organization. The protected manual gate remains dependent on independent review of its parent stack.
