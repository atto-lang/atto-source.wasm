# Delegated checked u64 Wasm candidate

The compiler stays owned by [LLVM #1008](https://github.com/atto-lang/atto-source.llvm/pull/1008), exact head 76e6faf97cd3c5822bd4223429c3c777a46d32e9, source blob f7bf08fc2ccd46116fe69359ef047f08068f04bd. No independent shadow parser is added. With an authorized local copy of that exact source and clang/clang++/wasm-ld, execute:

```sh
ATTO_U64_WASM_REQUIRED=1 ATTO_U64_LLVM_SOURCE=/absolute/path/atto_checked_u64.cpp node --test tests/atto-xo-checked-u64-wasm.test.mjs
```

The strict test validates the compiler blob, compiles the exact copied bytes, checks binary identity before/after, executes all twelve unchanged Atto sources at O0/O2 with full BigInt unsigned observation, no host imports, exact function export and machine traps. Local clang 17/Node 22.16.0: 2 tests passed, 24 actual Wasm guest runs. Without compiler source the guest test is explicitly NOT_EXECUTED; in required mode missing source fails. Hosted CI, authenticated full compiler tree, production compile-ores integration, browser and typed fault ABI are not proven. No private export or cross-org token required. Do not mark general unsigned support on default Wasm compiler route.

Updated shared frontend pin: strict local test rerun passed 2/2, executing 24 actual Wasm guests; test blob c76b55d669beb255a7927d14d6da09027278b0d8. No full tree/hosted evidence.
