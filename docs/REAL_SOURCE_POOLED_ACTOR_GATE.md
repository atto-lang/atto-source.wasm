# Real Oreslang source actor → pooled WASM execution gate

Status: **experimental integration / not parity certified**. This stacks on
WASM PR #151 and builds the narrow compiler-generated source actor ABI already
implemented in the LLVM backend. No new Oreslang parser is introduced.

## Required exact-toolchain execution

```sh
export ORESLANG_LLVM_COMPILER=/absolute/path/to/real/oreslang-llvmc
# Mandatory executable pin, provisioned from an independently trusted CI step:
export ORESLANG_LLVM_COMPILER_SHA256=<exact-compiler-sha256>
npm run test:real-pooled-actors
```

This command **fails** without a real absolute compiler path. The normal
`npm test` can mark the two compiler-dependent tests SKIP when the compiler is
not supplied, but SKIP is never proof of source actor execution. Real compiler
provenance must additionally bind its exact source commit/tree to the compiled
binary; SHA-256 alone only identifies bytes.

The test fixture `tests/fixtures/wasm32-single-source-actor.ores` is identical
to the upstream native LLVM source actor fixture. The actual native compiler
must accept it with `--target=wasm32`; Clang/LLD links only the three generated
lifecycle exports plus an explicitly bounded private linear memory. The strict
WASM inspector rejects imports, start, table, GC/reference types, memory64,
shared memory and unbounded heaps. No fallback to hand-authored LLVM IR,
hardcoded Wasm binaries or a fake Oreslang compiler counts as passing the gate.

The executable test spawns **40 distinct module instances on only 2 Node
Workers**, runs 25 scalar turns per actor (1,000 source-generated messages),
checks independent actor state, then verifies stop/drain, restart identity and
fresh incarnation state. The same real LLVM frontend must also reject source
`spawn` and `send` operations with **zero LLVM IR** rather than treating a
previously unsupported feature as accepted.

## Architectural limits

- The source compiler only generates one scalar, non-suspending actor per
  module. Native actor creation inside source, Task/Future, await, generators,
  network I/O, typed non-i64 messages, channels, supervisor CONTROL and
  native/OresVM transport remain unsupported.
- These are trusted-only pooled Node Worker carriers, not an OS sandbox for
  malicious tenants. Any infinite-loop turn consumes its Worker until deadline
  and physically retires every actor on that Worker; other live carriers stay
  operational and can admit replacement actors. No interrupted guest is
  preempted and resumed.
- Future scheduler integration must insert verified `rt cooperate` safepoints,
  typed resumable frames and borrow revalidation. Actors retain exclusive
  execution leases across every guest callback/continuation and before
  any generation change or arena reclamation.
- Standalone WASM OresVM and native LLVM/Graal actor interop are separate
  source-executable acceptance gates, not provided by this compiler adapter.
- The generic `compile-ores.mjs` scalar entry continues to reject actor
  source. This new bridge has a separate, explicit actor-only ABI and does not
  grant host imports or NIO.

## Verification rule

Run full source-tree Node 22+ tests, this required real-compiler gate,
LLVM-native wasm32 source-actor CTest, and Wasmtime AOT checks against exact
Git heads. Treat zero-step CI failures as **NOT_EXECUTED**. Do not export
private source to a carrier without independent approval and an allowlisted
private destination. No merge or parity promotion based on local surrogate
harnesses alone.

See WASM issue #152, PR #151, and
`oreslang-source.llvm/docs/WASM32_SOURCE_ACTOR_GUEST_V0.md`.
