# AttoLang Wasm pooled-actor supervisor CONTROL and restart v1

**Evidence classification:** implementation and executable test sources authored; no hosted exact-head test has yet executed on this branch. This is a trusted, source-local Node Worker supervisor contract. Do not claim real `.atto` compiler-backed supervisor parity or Java/LLVM/Wasm parity until the required native guest gate actually executes.

## Dependency stack

This increment extends the current draft Wasm #424 → #420 → #417 → #415, and needs an independently verified real native LLVM compiler from draft LLVM #1551 → #1546.

`src/supervised-pooled-actor.mjs` exports `SupervisedPooledActor`, a stable **host-owned supervisor authority**, with ephemeral generation-scoped `current()` handles. Only a Worker receipt validated by `PooledWasmActors.#onMessage` can cause a restart. No guest closures, functions or lexical variables cross Wasm channels; the supervisor callback remains exclusively host-local.

## Authoritative terminal CONTROL

For a genuine `STACK_BUDGET_EXHAUSTED_V1` trap, the trusted pooled Worker must first unwind its host ActorArena, scrub the faulting actor's own Wasm memory, retire that ActorArena and deliver an exact-ticket/incarnation `actor_fault` receipt with zero live host frames and `retired=true`.

Only **after** the host verifies these conditions and revokes all accepted DATA/STOP operations for the dead actor does it mint an immutable `ACTOR_TERMINAL_CONTROL` record. It includes a nonsecret actor ID, terminal ticket, typed reason, and completed-quiescence evidence. The raw Worker authentication incarnation is never exposed to listeners.

The supervisor consumes this CONTROL to:

- Revoke all old-generation send/STOP handles **before** creating a replacement. An old handle returns `STALE_ACTOR_GENERATION`, never forwards to a successor.
- Spawn a fresh independent actor with the same **previously snapshotted and SHA-256-pinned Wasm artifact**. The actual pool mints a new monotonic actor ID and random private incarnation, and checks strict no-import binary ABI on every admission.
- Maintain a bounded `maxRestarts=0..4`, default 1, a bounded 64-waiter queue for `waitForGeneration(oldGeneration)`, monotonic generation numbers, and immutable last-control status.
- Keep sibling actors on the same physical Worker intact; no restart of the whole carrier.
- Reject an ordinary i64 result, any fake/malformed retirement receipt, unexpected failure, and unapproved terminal code as restart authority.

**Explicit STOP wins over automatic restart intent.** If STOP was queued after an already accepted failing DATA, STOP itself rejects with the terminal error. Even if its rejection arrives before CONTROL, the supervisor marks the old generation stopped and does not schedule a replacement.

For a verified, nonquota `WASM_UNREACHABLE_V1` actor retirement, the host emits a terminal CONTROL so the supervisor revokes the old generation, but the supervisor **does not restart it**.

For a forged receipt, carrier timeout or fatal host/Worker problem, actor-local retirement is not assumed. Only after independent Node Worker **physical exit** (`worker.threadId === -1` and confirmed exit receipt) can the host emit a separate `ACTOR_CARRIER_TERMINAL_CONTROL`. This revokes the generation without restarting; it is never conflated with typed actor-frame exhaustion. An uncertain termination retains the physical retirement hold.

No supervisor observer exception or rejected async notification may block the Worker pump or alter an already issued runtime result. Host CONTROL records are immutable but **not cryptographically authenticated** against adversarial host-process code; they are runtime-internal trusted observations.

## Tests and evidence levels

`tests/supervised-pooled-actor-v1.test.mjs` contains **eight tests**: seven real Node/Clang **synthetic-LLVM-to-Wasm** host/Worker tests and one real source compiler-backed guest test that is skipped in a host-only lane.

The seven host tests exercise:

1. Typed terminal actor A failure, single budgeted automatic restart from generation 1 to 2, old-generation send/STOP rejection, B survival on the **same Worker**, and second failure exhausting the restart budget.
2. Nonquota `unreachable` actor death revoking the old generation with no restart.
3. Explicit STOP racing behind a stack fault suppressing automatic restart.
4. Supervisor close retiring only its actor while a sibling B continues.
5. Wrong restart budgets, malformed onControl callback, mutated Wasm artifact and malformed pool callback admission failing before the carrier.
6. Forged `STACK_BUDGET_EXHAUSTED_V1` fault receipt with nonzero live frames failing closed: no typed CONTROL, no restart, physically confirmed carrier retirement, then old generation revoked.

7. Manual STOP drains the full bounded 64-generation-waiter queue without restarting the actor or leaving unresolved promise leaks.

The source-org workflow `.github/workflows/wasm-pooled-supervisor-control-v1.yml` runs Node 22 and Clang, requires seven host passes plus exactly one **skipped** real-compiler test, and produces an exact HEAD/tree/run-attempt artifact clearly marked `node_clang_synthetic_wasm_host_executed=true`, `atto_compiler_backed_guest_executed=false`. A step-less GitHub workflow cannot produce this evidence.

The separate mandatory real-guest gate is:

```sh
ATTO_REQUIRE_REAL_SUPERVISOR_GUEST=1 \
ORESLANG_LLVM_COMPILER=/approved/absolute/oreslang-llvmc \
ORESLANG_LLVM_COMPILER_SHA256=<approved-compiler-binary-sha256> \
ORESLANG_LLVM_SOURCE_SHA=<independently-verified-LLVM1551-HEAD> \
ORESLANG_LLVM_SOURCE_TREE_SHA=<independently-verified-LLVM1551-TREE> \
node --test tests/supervised-pooled-actor-v1.test.mjs
```

or `npm run test:real-supervisor-guest` with the four `ORESLANG_LLVM_*` variables. It compiles **unchanged canonical .atto** actor blob `947781cddf09d8e3e08c51cff2b7d8960e2d4750` through the approved compiler and Clang, then exercises actual typed quota at the attempted 65th guest frame, independent B, one automatic fresh-generation restart, and stale generation rejection. Binary SHA alone cannot establish which source produced the executable; independent source/build-chain attestation is mandatory.

## Unverified follow-ons

1. Full hosted exact-head Node/Clang suite after source-org Actions payment/spend-limit admission is restored.
2. Actual compiler-backed `.atto` guest execution of the supervisor gate; exact LLVM HEAD/tree/compiler SHA and Wasm SHA receipts, not a synthetic IR stand-in.
3. Semantically reconcile the stacked LLVM/Wasm PRs, then obtain independent counted review. Do not force-merge untested drafts.
4. Separate **guest suspension and resume-ticket generation fencing**, actor-owned continuation state, manual supervisor STOP/close during restart, carrier-exit/rejoin policies, and legitimate mailbox backpressure. The current scalar actor ABI is synchronous and **cannot prove stale guest resume-token semantics**.
5. General direct/mutual/indirect recursion and Java/LLVM/Wasm parity with the canonical `.atto` source; this first v1 implementation only accepts one pure recursive helper shape.
6. Physical OS/tenant sandbox isolation is not provided by Node Workers; do not treat this runtime-only work as an untrusted sandbox.

Organization-wide GitHub provider admission incident [conformance #315](https://github.com/ores-truffle-oreslang/oreslang-platform-conformance/issues/315) reports failed payments or a spending-limit block. The account billing owner must identify the precise condition, authorize its repair, then run a **source-free same-org canary with nonzero executed steps** before claiming that any of these workflows passed.
