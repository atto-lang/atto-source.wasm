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


## Integrated task/frame STOP contract (2026-11-20)

The actor task ledger from Atto history-migration PR #49 is preserved
and integrated in this PR; the original task-ledger source blob was
reused byte-identically, then extended with a read-only stopped getter
for verification. The canonical #415 ActorArena remains the **only**
host frame/turn authority. These are different *kinds* of authority:
there is one task ledger and one frame ledger per actor incarnation.

Every INIT/SEND/STOP ACK must have both:
- canonical versioned `frame` with activeExecutions=0,
  frameBytesInUse=0 and matching STOP retirement;
- independent versioned `task` with outstanding=0 and
  stopped=true on STOP (false on INIT/SEND).

The Worker calls taskLedger.stop() before teardown, rejects a live or
suspended task even after cancellation, runs teardown synchronously,
scrubs private guest memory, retires the ActorArena, checks for no
lifetime pins, and only then acknowledges STOP. The parent rejects
missing, forged, accessor, proxy, extra-field, stale-profile, or
operation-mismatched ACKs, quarantining the entire Worker carrier.
Actor task cancellation is not a physical retirement receipt.
Untrusted guests have no task-ledger/Wake import in this profile.

## Signed compiler-frame artifact approval

Profiled actor runtime admission now supports a **strict, opt-in**
host-authenticated lane. A trusted host provisions an Ed25519 *public*
verification key. Every actor on that pool must supply a signed
canonical approval statement binding:

- frame profile and cell count (2..17 scalar or 64-slot stack);
- the exact SHA-256 of the instantiated Wasm bytes;
- source SHA-256, LLVM IR SHA-256 and independently approved compiler
  executable SHA-256;
- the fixed pooled actor ABI version and approval schema.

The public key never comes from guest input; the private signing key
must never be passed to the runtime. Unknown/unapproved profiles,
bad signatures, wrong bytes, missing approvals, and attempts to fall
back to unsigned legacy mode in a configured signed pool fail closed.
The Worker independently rehashes its received module bytes and checks
that every ACK preserves the host-approved profile label.

**Important distinction:** A signature proves that the provisioned
signer approved the statement, not that the claimed compiler HEAD,
generated IR, formal bounds, or hostile TenantVM security was
actually verified. Review the signer/deployment trust chain
separately. A pool without a configured verification key retains
only its historical trusted, **unprofiled** compatibility mode;
it cannot make signed profile claims.

## Physical Worker termination and runtime tests

Worker.terminate() Promise fulfillment or an emitted 'exit' event
alone is insufficient to reclaim actor references. The host waits
for the native Worker threadId=-1 exit event and a terminal receipt,
pins resources on uncertainty and conservatively fails close().
The latest head adds dedicated test files for task STOP races,
stale wake tickets, nested task retirement, forged task/frame
receipts, Ed25519 signature/digest tampering and real pooled
synthetic-Wasm profile behavior.

Workflow:
`.github/workflows/actor-frame-task-exact-head.yml`
requires exact PR head/tree evidence, two real Node 22/24 jobs,
zero-skipped focused tests and Clang-backed pooled guest execution.
Full npm test is additionally required on Node 22.
The workflow does **not** claim real .atto compiler-frame guests,
Wasmtime Native AOT or hostile TenantVM containment.

## Private CI carrier authorization blocker

The Atto repo's
`.github/private-ci-approved-repositories.txt` and
`.github/private-ci-approved-source-snapshots.txt` are empty;
`.github/private-ci-independent-reviewer.json` has
enabled=false. Thus NO alternate cross-organization runner destination
or exact source snapshot is currently authorized. Available GHA
minutes elsewhere alone do not grant source-transfer permission.
No private source has been mirrored elsewhere by this PR.

A repository owner / independent authorized reviewer must approve
the exact destination repository ID and exact source commit/tree,
enable the reviewer gate, and satisfy required CODEOWNERS/security
checks before a private cross-org mirror is attempted. Absent
approval, run exact-head Node/LLVM/Rust suites on approved same-repo
or locally trusted environments, and preserve NOT_EXECUTED for
the blocked hosted jobs.

**Keep draft until real executed tests, #49 merge reconciliation and
independent review are complete.**
