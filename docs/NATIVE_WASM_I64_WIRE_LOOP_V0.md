# LLVM-native C++ ↔ pooled WASM actor DATA loopback v0

**Status: experimental, trusted local host integration only.** Not full OresVM
native actor interop, source-level cross-actor \`send\`, a native-signed ActorRef
protocol, authenticated network messaging, or supervisor CONTROL. This is
the first executable *transport and actor-turn integration* building on
WASM draft PRs #151/#154 and LLVM source-guest draft PR #1088.

## Actual wire contract

The native executable uses \`oreslang::wire::encode/decode\` from
\`src/main/cpp/oreslang/runtime/MessagePackWireV2.hpp\` in the LLVM repo.
The WASM host uses a separate strict JavaScript implementation with the
same canonical shape descriptor:

- shape: \`T[I,I]\` (two signed i64 fields: positive ticket and scalar value)
- shape SHA256: \`sha256("oreslang.actor.shape.v2/T[I,I]")\`
- MessagePack v2 envelope: \`[2, schema_id, bin8(32) shape_digest, [ticket, value]]\`
- DATA schema IDs: \`oreslang.native_wasm.data.request.v0\`,
  \`oreslang.native_wasm.data.response.v0\`, \`oreslang.native_wasm.data.ack.v0\`
- bounded process-pipe frame: four-byte big-endian byte length, followed by
  at most 4,096 message bytes. No partial frame or trailing payload accepted.
- canonical smallest-width signed integers. Out-of-range i64, wrong schema,
  wrong digest, duplicate/out-of-order ticket and oversized frames fail closed.

The C++ peer initiates one native→WASM DATA request per ticket, the host
schedules that request on one of 40 private WASM actor instances over two
Node Workers, then relays the WASM handler result to native. The native
peer checks the per-actor expected counter and returns the computed
acknowledgment \`result + 100\`. The host also verifies each acknowledgment.
The target test is 1,000 round trips.

## Mandatory executable gate

First build the actual LLVM \`oreslang-llvmc\` and the native executable
\`oreslang-native-wasm-i64-wire-peer\` from pinned, reviewed source commits.
Pin the actual executable bytes:

\`\`\`sh
export ORESLANG_LLVM_COMPILER=/absolute/path/to/oreslang-llvmc
export ORESLANG_LLVM_COMPILER_SHA256=<64-lowercase-hex>
export ORESLANG_NATIVE_WASM_PEER=/absolute/path/to/oreslang-native-wasm-i64-wire-peer
export ORESLANG_NATIVE_WASM_PEER_SHA256=<64-lowercase-hex>
npm run test:native-wasm-loop
\`\`\`

The runner must fail with NOT_EXECUTED when a required actual executable or
digest is missing. Native binaries are privately snapshotted and the exact
staged SHA-256 is reverified before execution; the real source compiler is
likewise pinned. Checksums alone do not attest to compiler source provenance.

The default \`npm test\` executes pure MessagePack wire positive/adversarial
tests. It may **SKIP** the native+compiler test without the pinned toolchain.
Never count that skip as an interoperability pass.

LLVM's separate \`native_wasm_i64_wire_v2_peer\` CTest compiles the native
C++ implementation and executes an independent Python byte-vector oracle,
including malformed/replayed requests. It is a precondition, not a
substitute for the real compiler + pooled WASM run.

## Nonclaims and required next work

- No source \`spawn\`/\`send\` or typed \`ActorMessageCodec<T>\` lowering.
  The native executable is a **trusted C++ wire peer**, not a source-compiled
  native OresVM actor or supervisor. The WASM actor is a compiled scalar
  Counter source guest when the mandatory gate actually executes.
- Host-only ticket routing is not a cryptographic ActorRef or remote
  capability. No user DATA may grant CONTROL authority or make an ActorRef.
- No cross-process untrusted sandbox or untrusted native peer. Both process
  and WASM pool require explicit trusted admission.
- No asynchronous source continuation, borrow across \`await\`, hard
  preemption or isolated worker-memory proof for hostile code. A poisoned
  Worker may terminate colocated trusted actors after a physical barrier.
- The next feature must use host-minted generation-fenced opaque ActorRef
  capabilities, bounded typed MessagePack DATA, **separate supervisor
  CONTROL** and correct move/borrow semantics. Then add async mailbox
  suspension and real native source-actor integration.
- Source-org workflows that fail before executing steps are
  **NOT_EXECUTED**; private-source transfer needs independently approved
  destination, exact tree/SHA allowlist and protected-main review.
