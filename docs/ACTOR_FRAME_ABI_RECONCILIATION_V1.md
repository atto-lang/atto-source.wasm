# AttoLang Wasm actor-frame reconciliation v1 (draft)

## Canonical decision

AttoLang uses **#415 ActorArena turn authority** as its single trusted pooled
Worker host-frame authority. #416's independent host-only ActorFrameLedger is
not installed alongside it. Its useful actor-private, LIFO, exact-incarnation
and scrub-on-STOP properties are adapted via ActorArena and
withManagedActorTurn.

Every successful INIT/SEND/STOP Worker ACK carries the exact versioned
trusted host quiescence receipt:

- schemaVersion: 1
- authority: actor-arena-v1
- frameBytes: 16 (trusted HOST logical scalar tracking frame)
- activeExecutions: 0
- frameBytesInUse: 0
- retired: true ONLY for acknowledged STOP after arena retirement and
  physical guest-memory scrub

The parent checks the active operation ticket, actor ID, random incarnation,
operation result and exact receipt before resolving a turn. Missing, stale,
accessor, extra-field or malformed receipts are carrier-fatal. No bare-ACK
compatibility downgrade. A Node Worker receipt is trusted host bookkeeping,
not remote attestation, guest-codegen proof or hostile-tenant authorization.

## Explicit compiler frame profiles (not host receipts)

Two opt-in, noninterchangeable compiler ABI contracts:

| actorFrameProfile | Compiler IR ownership | Admission |
|---|---|---|
| atto-wasm-actor-scalar-frame-v1 | scalar.frame.v1, 2–17 i64 cells | one exact layout, checked GEP/store/clear evidence |
| atto-wasm-actor-stack64-v1 | actor.frame.slots, 64 i64 cells + depth | one exact layout, depth/bounds/cleanup evidence |

The bridge refuses unknown/implicit profiles, duplicate or competing
layouts, wrong cell counts and missing markers before linking/publishing.
Profiled compilation requires .atto and SHA-256-pinned native compiler;
provenance carries the selected profile. Unprofiled four-export scalar
actors remain compatibility-only and do not claim compiler-frame parity.

The checks are IR-shape defense in depth, NOT LLVM CFG formal verification
or proof of correct stack semantics. The 64-cell guest layout is distinct
from the 16-byte host receipt, and neither isolates engine-native stack.

## Fault domain and security

Unknown traps, engine call-stack exhaustion, noncooperating infinite loops,
invalid receipts and failed cleanup remain whole-carrier fatal. No broad
actor-local catch/restart is introduced. Trusted guest admission and SHA-256
pins are not TenantVM security isolation: mutually untrusted tenant actors
must not share an unproven carrier. Strict per-tenant capability controls,
quotas, authenticated guest provenance and verified physical termination
are additional prerequisites.

All pooled init/send/stop invocations are synchronous. Host frame scratch
is copied and scrubbed; async calls, Promise returns, suspended or resumed
guest frames, borrowed views and recursive guest stacks remain unsupported.
No host frame bytes become guest imports.

## Competing-PR disposition

- Legacy [Wasm #415](https://github.com/ores-truffle-oreslang/oreslang-source.wasm/pull/415):
  canonical receipt/turn authority, adapted here.
- Legacy [Wasm #416](https://github.com/ores-truffle-oreslang/oreslang-source.wasm/pull/416):
  private-frame bookkeeping adapted; separate ledger and bare ACK superseded.
- Legacy [Wasm #419](https://github.com/ores-truffle-oreslang/oreslang-source.wasm/pull/419)
  and [#420](https://github.com/ores-truffle-oreslang/oreslang-source.wasm/pull/420):
  retained as distinct named compiler profiles.
- Legacy [Wasm #417](https://github.com/ores-truffle-oreslang/oreslang-source.wasm/pull/417),
  [#424](https://github.com/ores-truffle-oreslang/oreslang-source.wasm/pull/424)
  and [#453](https://github.com/ores-truffle-oreslang/oreslang-source.wasm/pull/453):
  independent follow-up; current unknown/engine traps remain carrier-fatal.
- Atto [Wasm #49](https://github.com/atto-lang/atto-source.wasm/pull/49):
  migration PR overlaps pooled-actor-worker.mjs. Reconcile and retest
  both changes before either merge; do not squash the history migration.

## Testing and release holds

Run Node 22/24:
    node --test tests/actor-frame-reconciliation.test.mjs tests/actor-frame-profile-admission.test.mjs
    node --test tests/pooled-actors.test.mjs tests/actor-arena.test.mjs
    npm test

Existing real pooled fixtures require a working Clang wasm32 target. Full
compiler-frame claims further require an independently approved exact
LLVM source HEAD/tree and binary SHA-256, real .atto guest execution of
BOTH compiler profiles, source/IR/Wasm hashes, reject-without-artifact
negatives, sibling fault tests, independent security review, and stepful
GitHub Actions jobs at the exact Atto PR head. Verify Wasmtime AOT,
resource/ownership/rollback gates and TenantVM isolation separately.
Do not promote host tests, skipped native tests or zero-step CI failures to
real guest execution evidence. Keep DRAFT until applicable gates pass.
