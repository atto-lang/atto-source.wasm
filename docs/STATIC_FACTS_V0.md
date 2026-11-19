# Common advisory static facts v0 — WebAssembly compiler bridge

`node scripts/static-facts-v0.mjs --compiler=/absolute/llvmc
--source=/absolute/input.ores [--clang=clang]` emits v0 JSON **only after**
the existing `compileOresToWasm` compiler bridge successfully snapshots and
executes the pinned native compiler bytes, checks wasm32 LLVM target and
entry signature, invokes Clang/lld, validates WebAssembly, requires no
host imports and bounds the linear-memory contract. It additionally checks
the bridge's real `sourceSha256` provenance against independently read
source bytes.

The narrow source grammar permits only a single comment-free literal
`main():int` and rejects calls, loops, actors, tasks, imports and unmodeled
effects. This is NOT a source AST analyzer or a general proof of WebAssembly
guest termination, zero GC, callback timing or actor isolation. JSON's
`unit` hash identifies source bytes; it cannot authenticate a third-party
compiler or its repository commit by itself.

`npm test` exercises source/negative admission. A true positive must use an
authorized real LLVM compiler, Clang, and the exact staged output on a runner;
it is not implied by these source-only tests. Do not mirror private
cross-organization compiler sources against transfer restrictions.
