# Guard v1: Java / LLVM / Wasm compiler-backed conformance

This is an **execution gate**, not a declaration that Wasm already implements every
Java or LLVM language feature. The compiler is the real, independently authorized
`oreslang-llvmc` from `oreslang-source.llvm`. The Wasm repository does not
contain an alternative AttoLang parser.

## Canonical source identity

The following Git blob IDs were verified as identical in
`oreslang-source.java`, `oreslang-source.llvm` and
`oreslang-source.wasm` on 2026-11-07.

| .atto source | Git blob |
| --- | --- |
| `contracts/guard-v1/canonical-scalar.atto` | `c86ac476e55074031c0bcda02f5eaf3cb1399477` |
| `contracts/guard-v1/reject-fallthrough.atto` | `1ff87aa95ed2537839347e80984c69ae46fdfa17` |
| `contracts/guard-v1/reject-else.atto` | `b2bbee98cd3b95ac19462b4efd95a2e98b469154` |

The byte pins are checked in both the Node test and the manual workflow.
All new AttoLang source remains `.atto`.

## Executable tests

`tests/guard-v1-native-guest.test.mjs` performs:

1. Source-only: verify all three Git blob identities (runs in `npm test`).
2. Host-only: fail-closed checks for missing compiler path, binary SHA-256,
   and reviewed LLVM source head (runs in `npm test`).
3. **Compiler-backed** (required mode): verify compiler executable SHA-256;
   compile the canonical `.atto` through LLVM IR and Clang to bounded
   zero-import wasm32; verify the atomically published executable manifest
   and source/compiler/guest digests; execute the actual Wasm guest. The
   canonical result must equal **42**.
4. Compiler-backed derived Wasm-only probes: replace the canonical call with
   arguments 0, -7, 5, 10 and 9 and require results 1, 1, 2, 2 and 42.
   These five probes are *not* separately pinned cross-backend fixtures.
5. Compiler-backed negatives: each invalid canonical `.atto` must exit 1
   with `oreslang-llvmc:` diagnostic, emit no partial LLVM IR, and leave no
   Wasm artifact, release directory, or pointer.

The six successful guest executions and two compiler rejections must all
complete; a skipped test or a passed source-only test does **not** count as
Wasm guard semantic parity.

Run (with a separately approved and built compiler):

```sh
ATTO_REQUIRE_GUARD_WASM_GUEST=1 \
ORESLANG_LLVM_COMPILER=/absolute/path/to/oreslang-llvmc \
ORESLANG_LLVM_COMPILER_SHA256=64_lowercase_hex_digits \
ORESLANG_LLVM_SOURCE_SHA=40_lowercase_hex_digits \
node --test tests/guard-v1-native-guest.test.mjs
```

The approved manual `.github/workflows/atto-library-core-real-llvm.yml`
runs the test only after exact Wasm checkout, approved protected `main`,
same-organization private compiler authorization, exact reviewed LLVM
source checkout/tree, executable hash, and the existing Core fixture gate.
That job requires six executed guest diagnostics, two diagnosed rejections,
3 passed tests, and 0 skipped tests. It saves the full process log and
receipt. A source-commit label alone does not prove compiler binary provenance.

## What remains unproven

- Until an independently reviewed **nonzero-step, exact-head** manual workflow
  has run, Java/LLVM/Wasm executed guard parity is **NOT_VERIFIED**.
- `steps=[]` / `steps=null` and `runner_id=0` indicate runner admission,
  not a passed or failed language test.
- Node worker execution is not an OS sandbox or proof of production isolation.
- This is a scalar `() -> i64` bridge, not actors, channels, async,
  `Option` narrowing, or the complete Java/LLVM language.
- Independent Java and native LLVM guest receipts are still required; a Wasm
  result cannot substitute for them.
- This change adds tests and execution gating, **not new native lowering**.
  If the current LLVM compiler cannot lower `guard`, the required gate must
  remain red until source-level lowering and runtime semantics are implemented.
