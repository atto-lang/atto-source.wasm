# NIO and physical actor-turn semantics — portable v1 contract

Status: **normative backend-neutral contract**.

This document defines observable safety and ownership requirements. It is not a claim that every backend implements every capability. A backend that cannot implement a requested capability safely MUST reject it explicitly before executing guest code or producing a runnable artifact that claims that capability.

## 1. Asynchronous I/O and reactor ownership

1. Guest I/O advertised as nonblocking MUST NOT park an ordinary actor, CONTROL, or root execution carrier while waiting for external readiness or completion. A pending operation suspends logical work and returns physical execution capacity to its scheduler.
2. A reactor/readiness/completion thread MAY block only in the host/kernel readiness mechanism and MAY perform bounded host bookkeeping. It MUST NOT execute guest code, arbitrary Future subscribers, or actor callbacks.
3. Completion records MUST be bounded, ownership-tagged, generation-fenced, and safe under cancellation, close, descriptor reuse, and stale completion races.
4. Guest continuation resumption MUST be enqueued to the owning scheduler/domain. A backend MAY use a bounded host-only bootstrap/helper worker to make a cold scheduler runnable, but that worker MUST NOT execute guest completion code, MUST be observable in physical-worker accounting, and MUST NOT consume or starve the final CONTROL progress capacity.
5. Normal throughput profiles SHOULD avoid resident reactor/carrier workers when no independently runnable work requires them. A backend/profile MAY prestart bounded CONTROL or warm workers as an implementation choice. Such prestart policy is not a source-language semantic and MUST be bounded and observable.
6. Pending I/O, actors, ActorGroups, mailboxes, suspended continuations, or registered handles MUST NOT consume physical execution-carrier credits merely by existing.

## 2. Physical execution accounting

1. A backend that advertises a VM-wide physical execution-carrier budget MUST enforce one actual authority for every worker/domain included in that claim. Independent pool maxima MUST NOT be represented as a shared global budget unless aggregate admission is actually enforced.
2. CONTROL/failure progress MUST retain bounded capacity independent of ordinary DATA saturation.
3. Any worker class excluded from an advertised carrier budget MUST be explicitly classified as a separate bounded resource. If its implementation later changes to dedicated platform/native workers, the backend MUST either admit those workers through the shared authority or continue to disclose them as a separate bounded topology resource.
4. Explicit user-created fixed schedulers, where supported, MAY own dedicated physical carriers because the user requested them. They MUST NOT be created implicitly per actor, ActorGroup, mailbox, socket, or suspended task.
5. Permit/credit retirement MUST follow physical worker retirement, not merely logical cancellation or queue removal.

## 3. Future -> await and continuation safety

A backend that implements Future-to-await or an equivalent suspension bridge MUST guarantee:

1. completion, cancellation, and waiter-registration races produce at most one logical resumption and cannot lose a terminal result;
2. stale generation/incarnation completions cannot resume a replacement or retired actor/domain;
3. resumption occurs through the owning scheduler/domain, never by directly executing guest code on a reactor/completion thread;
4. cancellation/revocation reaches an authoritative terminal state before a suspended guest continuation is resumed with cancellation;
5. waiting on a Future does not park an actor/scheduler carrier merely to observe completion.

A backend without this capability MUST reject the unsupported source/runtime surface rather than emulate successful parity with blocking behavior.

## 4. Per-actor physical turns

Three limits are distinct and MUST NOT be conflated:

- logically outstanding message lifetimes, including suspended messages;
- actor-local simultaneous physical DATA turns;
- ActorGroup aggregate physical turns across multiple actors.

The canonical source API is:

```oreslang
define enum MaxActorThreads as
    LOW int = 1
    MEDIUM int = 2
    HIGH int = 3
end
```

Rules:

1. `LOW` is the default and means at most one physically executing DATA turn in a single actor.
2. `MEDIUM` and `HIGH` are upper bounds, not guarantees of resident or dedicated threads.
3. A backend MUST reject `MEDIUM`/`HIGH` before executable lowering until it can prove independent per-turn frames, owned/Sendable message data, safe immutable sharing, exclusive mutable-state access, cancellation/finalizer/lifecycle quiescence, and backend runtime thread safety.
4. A host-only 1..3 credit primitive is not authority to execute source actors concurrently.
5. A live mutable actor-state loan MUST NOT cross await/select/suspension. Contention must suspend/requeue rather than park a physical carrier.
6. Unknown enum members, ordinal substitutions, duplicate declarations/annotations, literal numeric substitutes, or unsupported actor execution MUST fail closed.

## 5. Shutdown, retirement, and ownership

1. Once an asynchronous operation is admitted and ownership is established, shutdown/retirement MUST settle, cancel, or otherwise account for that operation before retiring the execution domain that owns its continuation.
2. A backend MAY choose its own concrete teardown phases and component order, provided accepted completions cannot be stranded and late callbacks cannot resurrect retired state.
3. Stop/failure/cancel races MUST publish at most one authoritative terminal state per actor/domain incarnation.
4. Physical retirement success MUST NOT be forged from logical queue removal, cancellation request, or a discarded worker receipt.
5. Shutdown from an execution context that would require self-joining an owned worker MUST fail closed or otherwise use a proven non-self-join mechanism.

## 6. Reliability and operability invariants

Where the related capability exists:

1. overload paths and internal queues MUST be bounded; saturation returns a typed/reasoned admission failure or an explicit bounded-loss signal rather than hidden worker/queue growth;
2. CONTROL/failure progress MUST remain independent of ordinary DATA saturation;
3. arbitrary observers/callbacks MUST NOT become lifecycle authority and MUST NOT run under actor lifecycle locks merely because another executor is saturated;
4. finalization MUST be idempotent and generation-fenced;
5. operational counters/snapshots exposed to users or tooling SHOULD tolerate concurrent sampling without mutating runtime state or failing solely because fields changed between reads.

Separate terminal-journal, lifecycle-observer, telemetry-retention, or restart-policy contracts may impose stronger requirements. Carrying this NIO/actor-turn contract does not claim those separate subsystems are implemented.

## 7. Unsupported capabilities and parity claims

1. Explicit fail-closed behavior is conforming for unsupported capabilities.
2. Host primitives, mocks, static contracts, source-free models, or compiler-only checks MUST NOT be reported as proof that guest runtime support exists.
3. Async-looking APIs MUST NOT silently use blocking host calls when the backend/profile claims nonblocking I/O.
4. A backend MAY use a host-provided event loop when it cannot own reactor threads, but it MUST verify that the guest operation is genuinely nonblocking and MUST NOT claim thread-count controls the platform does not expose.

## 8. Evidence boundary

Conformance evidence for an implementation claim SHOULD record the exact source commit, Git tree, relevant contract blob, runner-executed job/step evidence, compiler/runtime profile, and source-level positive and negative fixtures.

A zero-step workflow proves neither pass nor fail. Documentation-only agreement with this contract proves semantics were specified, not implemented.

Private source movement is governed by the repository security policy and approval ledgers; this contract grants no source-transfer authority.
