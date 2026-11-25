# Conditional-expression v1 compiler-backed Wasm gate

The adjacent shared JSON contract is byte-identical to the Java and LLVM reference, Git blob `e3da61d86e556e801454029acef3bc4879d954a9`.
The five contract vectors and four checked-overflow branch-selection probes use canonical `.atto` guest files.

By default, the test checks only host-side fixture identity; it cannot certify compiler or guest execution.
To require the real gate, run in an independently authorized source-owned CI environment:

```sh
ATTO_WASM_CONDITIONAL_REQUIRED=1 \
ORESLANG_LLVM_COMPILER=/approved/path/to/oreslang-llvmc \
ORESLANG_LLVM_COMPILER_SHA256=<binary-pin> \
ORESLANG_LLVM_SOURCE_SHA=<verified-source-head> \
ORESLANG_LLVM_SOURCE_TREE_SHA=<verified-source-tree> \
node --test tests/conditional-expression-v1-wasm-guest.test.mjs
```

Source head/tree-to-binary provenance must be independently verified by CI, not merely provided in environment variables.
Nine executed cases, exact bytes, zero host imports/capabilities, native diagnostic for non-bool conditions, selected-arm checked-overflow traps and independent review are mandatory for parity promotion.
No source-level guest parity is claimed without a non-skipped exact-head receipt; status is NOT_EXECUTED / NOT_CERTIFIED.
