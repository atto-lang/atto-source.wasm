
# Actor Runtime Resilience v1

Status: normative cross-backend runtime contract. Backend status is evidence,
not permission to claim unimplemented source features.

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

- ActorRef identity is generation-bound.
- Restart is an explicit supervisor policy, never hidden ordinary-failure behavior.
- Mail accepted by a failed incarnation is not implicitly replayed into a new
  incarnation. Durable replay requires an explicit protocol.
- Lifecycle fencing prevents admission after sealing/stopping.
- Runtime/group bookkeeping cannot resurrect a terminal actor.

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
15. stale-generation refs cannot address a replacement incarnation;
16. shutdown/cancellation races cannot fabricate message processing;
17. no terminal observer callback executes under the lifecycle lock;
18. host-fatal injection still leaves best-effort terminal/fence state before rethrow;
19. blocked terminal observers retain only bounded lifecycle capacity and cannot
    create unbounded host workers or admit replacement actors past maxActors;
20. runtime shutdown cannot retire the lifecycle-observer domain while a
    removed/in-flight actor finalization can still publish its observer bundle.

## Backend status - 2026-10-17

| Backend | Status |
| --- | --- |
| Java/GraalVM | Active draft implements bounded mail/control, structured cancellation, single-flight execution, continuation fairness, typed send rejection, snapshots/stats, retained terminal state, ordered bounded terminal telemetry, watchdog isolation and two-phase finalization. Terminal ready/DONE/output/exit observers use a lazy bounded lifecycle-observer domain; actor capacity remains charged until that bundle retires, and runtime close fences in-flight finalization handoff before observer-domain shutdown. Source supervisor callbacks remain a release gate. |
| LLVM | Native actor/group and RT/thread-accounting primitives exist. The host scheduler now retains immutable generation-bound terminal metadata for explicit STOP and VM/runtime retirement, including accepted/processed user-message accounting and domain-fenced lookup. Callback failure has no typed return channel yet, so FAILED classification, source supervision, terminal diagnostics/journaling and the full observability/fairness contract remain parity work. |
| .NET | Contract target only; no source-runtime parity claim from this file. |
| WASM | Contract target; fail closed where threads/native isolation are unavailable. |
| Forge | Contract target; no source actor parity claim until executable fixtures pass. |
