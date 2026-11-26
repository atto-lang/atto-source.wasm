# Delegated checked u64 Wasm candidate

The compiler stays owned by [LLVM #1008](https://github.com/atto-lang/atto-source.llvm/pull/1008), exact head 76e6faf97cd3c5822bd4223429c3c777a46d32e9, source blob f7bf08fc2ccd46116fe69359ef047f08068f04bd. No independent shadow parser is added. With an authorized local copy of that exact source and clang/clang++/wasm-ld, execute:

```sh
ATTO_U64_WASM_REQUIRED=1 ATTO_U64_LLVM_SOURCE=/absolute/path/atto_checked_u64.cpp node --test tests/atto-xo-checked-u64-wasm.test.mjs
```

The strict test validates the compiler blob, compiles the exact copied bytes, checks binary identity before/after, executes all twelve unchanged Atto sources at O0/O2 with full BigInt unsigned observation, no host imports, exact function export and machine traps. Local clang 17/Node 22.16.0: 2 tests passed, 24 actual Wasm guest runs. Without compiler source the guest test is explicitly NOT_EXECUTED; in required mode missing source fails. Hosted CI, authenticated full compiler tree, production compile-ores integration, browser and typed fault ABI are not proven. No private export or cross-org token required. Do not mark general unsigned support on default Wasm compiler route.

Updated shared frontend pin: strict local test rerun passed 2/2, executing 24 actual Wasm guests; test blob c76b55d669beb255a7927d14d6da09027278b0d8. No full tree/hosted evidence.

## Generated Wasm guest corpus

The exact shared LLVM/Forge compiler source blob `752d1ad3fb3564eed9067a0a530eb2150d1c14b4` and generated Wasm test blob `a7fdff0a1fd27769982a7fddcf0041d763a2df80` passed all four independent partitions (eight Node tests/subtests, zero skips), 1,024 independently compiled and executed wasm32 guests: addition 189 values/67 faults, subtraction 195/61, multiplication 128/128, intermediate 190/66. Same deterministic source programs as JS #230 test blob `cbaa344006d453fb043126303d50d64fff6daa28`. Alternate O0/O2 by case index. The initial combined invocation exceeded the local execution budget; all four partitions were then rerun independently. Use `ATTO_U64_GENERATED_WASM_REQUIRED=1 ATTO_U64_LLVM_SOURCE=/absolute/shared.cpp ATTO_U64_WASM_FAMILY=add node --test tests/checked-u64-generated-wasm.test.mjs` and repeat with `subtract`, `multiply`, `intermediate`; omit family for all four. Missing/altered source and invalid strict selector failed; default unstaged mode explicitly skipped. This is delegated LLVM/Wasm candidate evidence, not an independent Wasm frontend, full-tree CI, browser ABI, or canonical certification.
