
# Actor Runtime Resilience v1

Status: normative cross-backend runtime contract for settled decisions, with
explicitly identified **proposals** below. Backend status is evidence, not
permission to claim unimplemented source features.

**Decision boundary (language spec chapter 18, merged PR #7):** restart from
last committed stored state, queued-but-unstarted mail carry-over, and checked
overflow failing the actor are language-owner decisions. The exact restart
budget, one-for-one/transient preset, outbound-send-at-turn-commit protocol and
pipeline abort-barrier default are **proposed initial policies**, not yet
ratified runtime guarantees. Cases 21-28 are proposed acceptance targets,
not existing executable fixtures or evidence of backend implementation.

This contract defines Oreslang fault-tolerance, overload, scheduling,
observability and lifecycle invariants. It deliberately avoids unbounded default
mailboxes, user priority escape hatches, silent send loss, lifecycle signals
queued behind user mail, callbacks inside actor locks, actor identity tied to
physical threads, and hidden restart/replay behavior.

## 1. Data mail and runtime CONTROL are separate resources

- User messages are FIFO per admitted actor stream and use a bounded user mailbox.
- Runtime continuations and lifecycle CONTROL use independently bounded reserved
  capacity. User code cannot relabel an ordinary message as CONTROL/priority.
- Supervisor terminal signals must never depend on room in an ordinary user mailbox.
- CONTROL never executes reentrantly over an already-running actor turn.
- A suspended source receive owns its logical execution context; unrelated user
  mail cannot race that invocation.

## 2. Bounded overload and explicit sends

- Every local actor mailbox has finite message and memory limits.
- No API may bypass the mailbox limit.
- A non-admitted local send fails explicitly with a typed reason such as FULL,
  SEALED, TERMINATED, INVALID_REFERENCE, lifecycle fencing, or transport failure.
- Admission is transactional: failed validation/copy/quota work releases every
  reservation.
- Accepted local mail is either processed or represented as abandoned terminal
  work. Oreslang does not claim distributed exactly-once delivery.

## 3. Fairness

- Dispatch uses a finite per-actor throughput quantum.
- Internal continuations have latency priority, but outside a suspended receive
  they cannot starve waiting user mail forever.
- Java v1 allows at most 32 consecutive continuations before a waiting user
  envelope receives selection priority.
- CONTROL capacity isolation is not permission for unbounded high-priority work.

## 4. Failure containment

- Ordinary throw follows local catch/trap semantics.
- raise is explicit escalation according to the language recover/defer contract.
- panic is actor-fatal, not VM-fatal merely because one actor failed.
- Integer overflow panics the actor. Wrapping happens only through explicitly
  named operations.
- Stack exhaustion, a guest trap and a turn-deadline kill are actor-fatal in the
  same way. A backend that cannot contain one of them must not run untrusted
  actors directly on that execution path.
- A fault showing the memory boundary itself failed, such as an access outside
  the tenant's memory, is VM-fatal and is never answered with a restart.
- Structured cancellation is control flow and cannot be swallowed as an
  ordinary guest exception.
- Host-fatal VM/linkage/thread-death class failures may be rethrown only after
  best-effort terminal fencing makes actor resurrection impossible.
- Child failure never synchronously unwinds a parent actor stack.

## 5. Two-phase finalization

Prepare under the actor lifecycle lock:
- verify no active guest turn/carrier and no live structured child;
- reserve exactly one finalization publication;
- detach mutable actor-owned scheduler/state references;
- capture immutable terminal accounting.

Publish without the actor lifecycle lock:
- close runtime-owned resources best-effort;
- commit output-stream terminal state;
- publish retained per-ref terminal metadata and best-effort global telemetry;
- reconcile group/runtime ownership;
- mark the actor finalized;
- progress the structured parent tree;
- only then run arbitrary ready, DONE, output or host observers.

No Future callback, output waiter, collector hook, group callback, or user
formatting routine may execute while the actor lifecycle lock is owned.

Arbitrary terminal observers must also be isolated from actor, CONTROL and
selector carriers. A bounded runtime may use a dedicated lazy observer domain,
but it must not fall back to executing a child observer inline on an unrelated
parent actor when an actor dispatcher is saturated. Observer capacity is
bounded: a blocked observer may retain lifecycle capacity/backpressure, but it
must not create unbounded threads, resurrect a terminal actor, or delay the
authoritative parent-tree transition that precedes observer publication.
Shutdown must fence every in-flight authoritative finalization handoff before
retiring the observer domain.

A cleanup/observer subsystem failure is counted and cannot leave an actor
permanently half-finalized. Host-fatal errors are deferred until best-effort
terminal state publication.

## 6. Authoritative terminal state vs diagnostics

Each ActorRef retains one immutable terminal record with:
- id, generation, kind and parent lineage;
- NORMAL, CANCELLED or FAILED classification;
- accepted and processed user-message counts;
- queued user/control work abandoned at finalization;
- stable failure type identity without executing user formatting.

The per-ref record is authoritative post-mortem metadata and cannot be evicted
by unrelated actor churn.

A runtime may also expose a bounded global terminal journal. That journal:
- is diagnostic only and may drop under observer backpressure;
- never blocks finalization;
- exposes explicit drop counters;
- preserves declared sequence ordering under concurrent actor death.

Supervisor restart/escalation policy must not depend on a droppable journal.
The future source on_panic/on_raise/on_throw path requires non-droppable typed
CONTROL admission tied to supervision authority.

## 7. Debuggability without perturbation

Supervisor snapshots expose immutable operational facts only: mailbox/control
depth, accepted/processed sequence counts, active/scheduled state, children,
pending operations, suspension/fence state, placement and bounded memory usage.
They never expose mutable guest heap by reference or execute guest code.

Runtime counters distinguish at minimum:
- accepted and processed user messages;
- mailbox-full, sealed, terminated, invalid-ref and lifecycle-fenced sends;
- continuation admission failures;
- normal, cancelled and failed terminations;
- watchdog overruns and dropped watchdog notices;
- dropped terminal diagnostics;
- lifecycle publication/cleanup anomalies.

Diagnostic producers never wait for diagnostic consumers.

## 8. Watchdog semantics

- Watchdogs observe independently of actor carriers.
- Thread interruption is not actor identity or proof of safe actor cancellation.
- Preemption requests take effect only at defined scheduler safepoints.
- Stale leases cannot fire after actor/carrier reuse.
- A broken observer cannot suppress other actors' watchdog progress.

## 9. Identity, restart and stale-mail safety

Identity:

- A reference from `spawn` addresses an actor instance, and resolves to its current
  incarnation. A restart does not invalidate it, so a restart never strands the
  actor's callers.
- Once the instance has ended, by stopping or by spending its restart budget, a send
  through its reference fails as TERMINATED. The reference never reaches a different
  instance, even one reusing the same slot.
- Supervisor-published routes, including pipeline edges, also address an instance ID.
  A restart does not change the topology generation.
- A backend may also offer a handle bound to one incarnation. Such a handle never
  addresses a replacement. No current source feature requires one.
- A reply is correlated to the incarnation that asked for it. A reply to a failed
  incarnation is rejected as stale and never reaches its replacement.

Restart policy (restart decision; operational defaults proposed):

- Restart is a declared supervisor policy, never hidden behavior. A proposed
  default is
  `one_for_one` with `transient` children: an actor that fails is restarted, and
  one that stops normally is not. Every restart is counted and reported on CONTROL.
- A restart budget bounds restarts, with backoff between attempts. A proposed
  starting value is
  3 restarts in 10 seconds. Restart work is charged to the tenant's CPU budget.
- A restart is a new incarnation with a new generation. Runtime or group
  bookkeeping cannot resurrect a terminal incarnation.

Turn commit and stored state (stored-state survival decided; send protocol proposed):

- The runtime stores each actor's sealed state outside memory the actor can
  address. Stored state outlives the incarnation but not the tenant VM. Surviving
  VM or process failure requires an explicit durable protocol.
- Proposed atomic turn protocol: a successful turn commits state and outbound mail
  together. A failed turn
  commits neither, so its private changes and unpublished sends disappear.
- Proposed reservation protocol: a send made during a turn reserves mailbox
  capacity and returns its admission
  result immediately. The message is published at commit, and a failed turn
  releases the reservation.

Restarting a failed actor:

- The new incarnation gets fresh memory, runs initialization, then loads the last
  committed state.
- The message being processed when the turn failed is never redelivered, because
  it may have caused the failure. A waiting caller receives a typed actor failure,
  and the supervisor receives a non-droppable record of the loss.
- Mail queued but not started carries over to the new incarnation in FIFO order.
  It never ran, so this is not replay. Durable replay of started mail requires an
  explicit protocol.
- Mailbox limits still apply during a restart, so sends may fail as FULL. Senders
  do not see TERMINATED while a restart is still possible.

Proposed terminal-stage behavior once a restart budget is spent:

- Sends to it fail as TERMINATED, and its queued mail is reported as abandoned.
- Each downstream edge receives an upstream-failed signal after that edge's accepted
  mail. This signal is distinct from normal completion, so partial data never looks
  like a finished stream.
- Under the proposed default, the pipeline stops through an abort barrier.
  A supervisor may declare
  a different policy, and the failure escalates to its parent. The rest of the
  tenant keeps running.

Lifecycle fencing prevents admission after sealing/stopping.

## 10. Physical scheduling and memory

- Actor identity is never native/JVM thread identity.
- Default source execution is single-flight even when turns migrate.
- Ordinary actors share bounded carriers; actor count does not imply thread count.
- Selector and CONTROL threads never execute arbitrary guest callbacks.
- PRIVATE/UNTRUSTED actors do not acquire writable foreign actor heap aliases.
- Actor-local allocation domains are reclaimed independently of observer progress.

## 11. Required adversarial fixtures

1. mailbox-full is bounded and typed;
2. quota rejection rolls reservations back;
3. thousands of idle actors do not create one thread each;
4. hot-actor quantum cannot starve a peer;
5. self-replenishing continuations cannot starve waiting user mail;
6. suspended receive cannot admit unrelated user execution;
7. child failure stays supervisor-visible while parent user code is blocked;
8. blocked/throwing lifecycle observers never hold actor lifecycle locks or
   prevent structured parent progress;
9. cleanup/group/collector failure cannot strand registry removal;
10. full diagnostic journals/watchdog queues drop with counters instead of
    backpressuring actor execution;
11. concurrent actor death yields no duplicate terminal record and preserves
    declared global ordering;
12. per-ref terminal metadata survives global-journal drops;
13. cancellation cascades through the child tree but is not ordinary catchable
    failure;
14. force cancellation fails closed without real isolation authority;
15. a reference to an ended instance cannot address a later instance, and a handle
    bound to one incarnation cannot address its replacement;
16. shutdown/cancellation races cannot fabricate message processing;
17. no terminal observer callback executes under the lifecycle lock;
18. host-fatal injection still leaves best-effort terminal/fence state before rethrow;
19. blocked terminal observers retain only bounded lifecycle capacity and cannot
    create unbounded host workers or admit replacement actors past maxActors;
20. runtime shutdown cannot retire the lifecycle-observer domain while a
    removed/in-flight actor finalization can still publish its observer bundle.
21. stack exhaustion in one actor, including during a host call, fails only that
    actor and leaves its siblings, other tenants and the process running;
22. a failed turn leaves no state change and publishes no outbound mail, and it
    releases its mailbox reservations;
23. a restarted actor loads its last committed state, skips the failed message
    and processes queued mail in its original order;
24. a `spawn` reference and a pipeline edge reach the new incarnation without
    rewiring, while a reply to the failed incarnation is rejected;
25. state that crashes the actor on every load spends the restart budget, then
    ends the stage without starving other tenants;
26. a consumer can tell an upstream failure from normal completion on every edge,
    including fan-in;
27. a fault outside the tenant's memory fails the VM and triggers no actor restart;
28. integer overflow panics only the actor that overflowed, on every backend,
    and sized integer types overflow at their own declared range.

## Backend status - 2026-10-17

| Backend | Status |
| --- | --- |
| Java/GraalVM | Active draft implements bounded mail/control, structured cancellation, single-flight execution, continuation fairness, typed send rejection, snapshots/stats, retained terminal state, ordered bounded terminal telemetry, watchdog isolation and two-phase finalization. Terminal ready/DONE/output/exit observers use a lazy bounded lifecycle-observer domain; actor capacity remains charged until that bundle retires, and runtime close fences in-flight finalization handoff before observer-domain shutdown. Source supervisor callbacks remain a release gate. |
| LLVM | Native actor/group and RT/thread-accounting primitives exist. The host scheduler now retains immutable generation-bound terminal metadata for explicit STOP and VM/runtime retirement, including accepted/processed user-message accounting and domain-fenced lookup. Callback failure has no typed return channel yet, so FAILED classification, source supervision, terminal diagnostics/journaling and the full observability/fairness contract remain parity work. |
| .NET | Contract target only; no source-runtime parity claim from this file. |
| WASM | Contract target; fail closed where threads/native isolation are unavailable. |
| Forge | Contract target; no source actor parity claim until executable fixtures pass. |

## Exact-tree qualification extension

Stress fixtures must include at least 512 distinct actor incarnations
stopping concurrently, with retained terminal records, post-callback
capacity reclamation, and a runtime-close/observer-drain race. These
requirements are not satisfied by source-free concurrency models alone.
