# AttoLang actor continuation ticket fence v0 — host-only admission

**Status: source-authored host admission, guest suspend/resume NOT IMPLEMENTED, hosted exact-head CI NOT EXECUTED.**

This is a deliberately incomplete bridge to future compiler-managed actor continuations. It does not implement `await`, suspension, guest return PCs, ownership roots, task scheduling, carrier migration, or a safe call into a suspended Wasm guest. Never count host ticket tests as language/backend parity.

## Threat model and authority

`src/host-continuation-ticket-fence-v0.mjs` defines `HostContinuationTicketFenceV0`:

- A host gate must explicitly `activate(generation)` a positive, increasing actor generation. `mint(generation)` only works in the current active generation, subject to a **64 outstanding ticket maximum**.
- Each ticket is a unique, frozen, null-prototype JavaScript object with **no enumerable fields**. Its authority resides only in a gate-private `WeakMap`; the gate-private `Set` strongly retains only pending tickets until claim, cancel or retirement. No guest pointer, closure, numeric ID, or serializable token is issued. A copied or structured-cloned object is **not** the same authority. Foreign gate tokens are invalid.
- `claimHostOnly(ticket, generation)` consumes a ticket **once** and returns an immutable `{kind: "HOST_CONTINUATION_ACCOUNTING_ONLY", guestResumeAuthorized: false}` receipt. Replay, foreign ticket, wrong generation, or retired ticket fails closed. This receipt must NEVER be interpreted as authority to call a Wasm guest export.
- `cancel(ticket, generation)` reclaims its quota; `retire(generation)` marks every outstanding ticket unusable, clears strong references, and is idempotent within the same generation. Only the immediate next generation may be activated.
- `resumeGuest(ticket, generation)` verifies ticket provenance, then **always throws `ATTO_GUEST_SUSPEND_RESUME_NOT_IMPLEMENTED`**. A stale ticket is rejected even before that unsupported-operation check. There is no invocation of guest code.
- All of this is *host-local*. Never pass a ticket through a channel/pub-sub, serialize it as JSON, translate it into a guest integer/pointer, or allow user-supplied numeric identifiers to count as capabilities.

## Supervisor integration

`SupervisedPooledActor` provides `issueHostContinuationTicket()`, `claimHostContinuationTicket(ticket)`, `cancelHostContinuationTicket(ticket)`, and `resumeGuestContinuation(ticket)`. It also reports `hostContinuationTicketsPending` and `guestContinuationResumeImplemented: false` in its read-only status.

On accepted explicit STOP, host-authoritative typed or generic actor terminal CONTROL, confirmed physical carrier retirement, invalid CONTROL, and close requested, **all existing-generation tickets are revoked before publishing any new actor generation or settling close**. After an authorized typed stack-budget restart, the new generation receives a fresh gate epoch; old opaque tickets remain stale even when the new actor is on the same Worker.

The supervisor only revokes/adjudicates *host ticket objects*. A source guest cannot request suspension or resume. Its current synchronous scalar actor ABI is unchanged (legacy four exports or restricted checked-recursion five exports); no sixth continuation export is admitted, and there is no host `resume` message operation.

## Verification inventory

- `tests/host-continuation-ticket-fence-v0.test.mjs`: **nine** authored Node host/model tests for opaque identity, one-use accounting, clone/foreign/replay rejection, 64 quota and reclamation, wrong generation and retired tickets, supervisor typed restart, explicit STOP, unexpected actor/carrier fault, close, and manifest fail-closed classification.
- The suite has **no actual `.atto` guest resume test**, because the compiler and runtime must refuse guest continuation admission. CI should produce a receipt marked `host_js_ticket_admission_executed=true` **only after actual Node job steps execute**, with `guest_suspend_resume_compiler_backed_executed=false`.
- Canonical negative source fixture: `contracts/actor-continuation-fence-v0/suspended-actor-negative.atto`, Git blob `aebd40549e88b49c906fd3fa2b0569ec7800deec`. Its attempted `suspends fnc` must **not** compile under the restricted synchronous wasm32 checked recursion profile. Rejection proves only negative admission, never that a valid suspension can execute.

A host-only CI workflow `.github/workflows/wasm-continuation-ticket-fence-v0.yml` runs Node 22, pins exact PR head and tree, and requires nine executed tests. Zero-step jobs remain `RUNNER_ADMISSION_FAILURE / NOT_EXECUTED`.

## Requirements before true guest continuation admission

The compiler/runtime still need: typed, borrowed-safe `.atto` suspension lowering; actor-owned continuation frame layout with return PC and owned roots; scheduler eligibility accounting and CONTROL fences; deterministic cancellation and teardown; provenance-checked per-actor generation/incarnation; negative mutation proofs; exact-head source/compiler/Wasm SHA receipts; and at least one real actor A suspended in generation 1, then terminated and restarted while old resume is rejected and actor B survives.

Until all are independently proved, **no `suspends fnc` in this Wasm actor profile may compile into a resumable guest export**. No optimistic stub, no implicit fallback to host lexical closure, no host `Promise` masquerading as an AttoLang continuation.

Do not bypass existing GitHub security/review gates or mirror private source to another organization to recover CI minutes. The original source organization's runner-admission incident is documented at https://github.com/ores-truffle-oreslang/oreslang-platform-conformance/issues/315. Billing remediation needs an authorized account owner, followed by same-org source-free stepful canary and exact-head native guest tests.
