# Real Oreslang source actor → pooled WASM execution gate

Status: **experimental integration / not parity certified**. This stacks on
WASM PR #151 and builds the narrow compiler-generated source actor ABI already
implemented in the LLVM backend. No new Oreslang parser is introduced.

## Pinned compiler build and receipt handoff (pending private CI authorization)

The WASM AOT workflow now calls `scripts/build-pinned-llvm-compiler.sh`
before the mandatory real-source actor gate. That script **does not clone,
fetch or mirror LLVM source**. It builds only from a preapproved, local,
clean Git checkout at exactly:

- LLVM commit: `a5114e57fe8e7a159ec9754478227912d339f70b`
- LLVM root tree: `6a9e76b9e5a9499b7db6d42a4c7e2dc1f2ecd90e`

It runs CMake against the pinned local checkout, builds
`build/oreslang-llvmc`, captures and verifies the compiler receipt through
LLVM's source-local `tests/verify_compiler_receipt.py`, and exports the
six required `ORESLANG_LLVM_*` paths and pins via `GITHUB_ENV`. The
consumer `scripts/verify-llvm-compiler-handoff.mjs` verifies the real Git
checkout, compiler digest, executable mode and *exact* four-field v1 receipt
bytes (including refusal of duplicate keys or extra success fields). The
mandatory `npm run test:real-pooled-actors` invokes that same consumer
even when run outside the GitHub workflow.

This stage **intentionally fails NOT_EXECUTED on ordinary GitHub-hosted
runners**, because no approved LLVM checkout provisioning mechanism exists
yet. The checked-in private-CI destination and source-snapshot allowlists
are empty and independent review is disabled. Do not add a checkout token,
enable private action sharing, transfer source to WASM, or bypass this gate
until the relevant source-owner approvals and protected policy review exist.
After authorization, a trusted runner can provision the precise local
checkout; the builder then becomes self-contained. On a newly approved
LLVM head, update *both* pins after review and rerun the mutation tests.

**Provenance distinction:** matching a compiler binary, source Git identity
and receipt is not a cryptographic attestation that the binary was produced
by a trusted runner, and the receipt is not proof of guest execution. The
build must run under an independently trusted CI definition; the actor
and AOT suites must execute and report their own nonzero steps and artifacts.

## Required exact-toolchain execution

```sh
export ORESLANG_LLVM_COMPILER=/absolute/path/to/real/oreslang-llvmc
# Mandatory executable pin, provisioned from an independently trusted CI step:
export ORESLANG_LLVM_COMPILER_SHA256=<exact-compiler-sha256>
export ORESLANG_LLVM_SOURCE_SHA=<exact-40-hex-compiler-commit>
export ORESLANG_LLVM_SOURCE_TREE=<exact-40-hex-root-tree>
export ORESLANG_LLVM_SOURCE_DIR=/absolute/path/to/clean/llvm-git-root
export ORESLANG_LLVM_COMPILER_RECEIPT=/absolute/path/to/fresh-compiler-receipt.json
node scripts/verify-llvm-compiler-handoff.mjs
npm run test:real-pooled-actors
```

This command **fails** without a real absolute compiler path, exact compiler
SHA-256, exact LLVM source commit/tree, a fresh matching compiler receipt, and a real clean LLVM Git root whose
HEAD and HEAD^{tree} independently match those pins. Tracked source changes,
symlink checkout roots, and missing/mismatched Git checkout evidence fail
before the actor test runs. Git identity checks do NOT establish that the
binary was built from that source; an independently reviewed source-local
build receipt must bind the compiler SHA-256 to the actual build. The normal
`npm test` can mark compiler-dependent tests SKIP when the compiler is not
supplied, but SKIP is never proof of source actor execution. The AOT workflow
therefore invokes this command as a separate mandatory step before its scalar
AOT smoke. A compiler binary hash identifies bytes; the commit/tree pins record
the independently verified source provenance that produced those bytes.

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
