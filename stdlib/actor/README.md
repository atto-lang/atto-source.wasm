# Atto `std/actor` — native `.atto` namespace

**Namespace:** `use namespace std.actor;` (not `define module actor`).
The current file is `stdlib/actor/policy.atto`. This is an owned compiler-local
implementation; there is no shared source-SHA parity requirement.

## Implemented now (pure policy, not privileged operations)

The exposed predicates are `actor_mailbox_admissible`,
`actor_future_transition_valid`, `actor_lifecycle_transition_valid`,
`actor_should_restart`, `actor_restart_first`,
`actor_restart_end_exclusive`, `actor_restart_budget_allows`,
`actor_next_generation`, `actor_failure_notifies_supervisor`,
`actor_cancel_request_admissible`, `actor_stop_request_admissible`,
`actor_stop_completion_admissible`, `actor_restart_generation_admissible`,
`actor_supervisor_notice_admissible`, and `actor_reply_admissible`.

- Lifecycle 0 created, 1 starting, 2 running, 3 stopping, 4 stopped, 5 failed.
- Future 0 pending, 1 success, 2 cancelled, 3 failed, 4 panicked.
- Restart policy 1 permanent, 2 transient, 3 temporary.
- Restart strategy 1 one-for-one, 2 one-for-all, 3 rest-for-one.
- Failure kind 1 throw, 2 raise, 3 panic.
- Restart spans use [first, end_exclusive). Invalid indexes return -1.
- Restart intensity charges **each actual child restart** within the trusted window.
- Cancellation is a request only; do not report `get_done()` or `ActorFuture`
  completion until authenticated, physically quiescent runtime execution proves it.
- Trusted runtime must authenticate actor/parent incarnation, tenant, CONTROL,
  mailbox authority, the output close, task retirement and physical quiescence
  independently; boolean arguments supplied by guests are **not receipts**.
- Panic goes to priority supervisor CONTROL even if a guest claims recovery.
  Throw/raise notify supervisor only when unrecovered.

**Do not synthesize** `ActorFuture<T>`, actor IDs, `ActorRef<T>` transport
authority or a fake supervisor in this policy file. The next runtime milestone
must bind built-in `spawn`, `send`, `stop`, `await get_ready()`,
`await get_done()`, cancellation, and supervisor priority CONTROL to real
scheduler/heap/mailbox/actor-generation capabilities. Async is the default;
no redundant `_async` suffix. Sync APIs, if added, require `_blocking`.

## Test plan and current evidence

- `tests/actor-stdlib-source.test.mjs`: Node source-structure assertions only.
- `stdlib/actor/guest_smoke.atto`: adjacent-import **real guest target**.
  Compile from the repository root via backend's actual compiler and execute;
  expected `main()` = 42, no unauthorized host imports.
- `contracts/std-actor-v1/guest-smoke.atto` was an invalid candidate
  (unsafe two-parent import path); it is replaced by the adjacent fixture.
- Guest compilation, actor lifecycle execution, Native AOT, supervisor failure
  escalation, cancellation races, mailbox concurrency and physical quiescence
  remain **NOT_VERIFIED** until actual exact-head execution and review.
- Unsupported targets (especially HDL and browser-only actors) must fail
  explicitly; parsing a file is not runtime parity.
