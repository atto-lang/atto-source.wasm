# Delegated checked u64 Wasm candidate

The compiler stays owned by [LLVM #1008](https://github.com/atto-lang/atto-source.llvm/pull/1008), exact head 2ed03e9c16b4089a945a3255aea464c193f91686, source blob 3f63b517b5fb0c7c679e0ed581b6d92c03a75a98. No independent shadow parser is added. With an authorized local copy of that exact source and clang/clang++/wasm-ld, execute:

```sh
ATTO_U64_WASM_REQUIRED=1 ATTO_U64_LLVM_SOURCE=/absolute/path/atto_checked_u64.cpp node --test tests/atto-xo-checked-u64-wasm.test.mjs
```

The strict test validates the compiler blob, compiles the exact copied bytes, checks binary identity before/after, executes all twelve unchanged Atto sources at O0/O2 with full BigInt unsigned observation, no host imports, exact function export and machine traps. Local clang 17/Node 22.16.0: 2 tests passed, 24 actual Wasm guest runs. Without compiler source the guest test is explicitly NOT_EXECUTED; in required mode missing source fails. Hosted CI, authenticated full compiler tree, production compile-ores integration, browser and typed fault ABI are not proven. No private export or cross-org token required. Do not mark general unsigned support on default Wasm compiler route.
