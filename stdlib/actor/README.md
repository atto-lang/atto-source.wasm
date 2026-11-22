# std/actor — backend-owned Atto source, v1

This slice is implemented in `stdlib/actor/policy.atto` in the Atto language itself.
Import with `std/actor` once compiler namespace wiring supports it; the candidate
relative-import guest smoke is `contracts/std-actor-v1/guest-smoke.atto`.
Do not claim `std/actor` import resolution works until it is guest-tested.

## Public pure-policy APIs

- `actor_mailbox_admissible`: requires trusted authority, running state, exact
  actor generation, Sendable payload and non-full bounded DATA mailbox
- `actor_future_transition_valid`: first pending-to-terminal settlement only
- `actor_lifecycle_transition_valid`: monotonic created/starting/running/stopping/terminal
- `actor_should_restart`: permanent/transient/temporary (1/2/3)
- `actor_restart_first`, `actor_restart_end_exclusive`: one-for-one,
  one-for-all, rest-for-one (1/2/3), half-open indices, -1 on invalid inputs
- `actor_restart_budget_allows`: per-actual-child window charging, checked subtraction
- `actor_next_generation`: prevents ABA/generation wrap
- `actor_failure_notifies_supervisor`: panic always, unrecovered raise/throw

All functions are pure and allocation-free. They cannot authenticate caller-supplied
identity, create supervisor authority, deliver priority CONTROL, establish real
ActorRef<T>, spawn, join, stop, cancel, or await actor work. The runtime must provide
those operations, and enforce mailbox closure and linearizable completion.

Atto asynchronous APIs should use `await actor.get_ready()` and
`await actor.get_done()` without an `_async` suffix. The eventual
`ActorFuture<T>` must support real runtime-backed completion and cancellation:
**do not implement it with a fake settled-state class**.

## Validation status

`tests/actor-stdlib-source.test.mjs` checks source structure only.
`contracts/std-actor-v1/guest-smoke.atto` is an unexecuted target until the
compiler supports imports and executes it. Native AOT, mailbox races, supervisor
CONTROL authentication, cancellation and actual actor lifecycle remain unverified.
This wasm library is owned locally by this compiler; cross-backend parity is behavioral,
not a shared-source SHA requirement.
