# NIO and physical actor-turn semantics — portable v1 contract

Status: **normative target, not a statement of feature completion**.
A backend that cannot implement an operation safely MUST reject it explicitly.
Partial host primitives are not authority to execute source actors concurrently.

## I/O and scheduling

1. I/O guest operations MUST be asynchronous and never block an ordinary
   actor, CONTROL, or root execution carrier. A pending operation suspends the
   logical task and returns the carrier to its runnable-work scheduler.
2. A dedicated reactor MAY wait only in its kernel readiness/completion API
   (for example epoll, kqueue, IOCP, or an appropriate Wasm host event loop).
   Reactor callbacks perform bounded host bookkeeping only. **Guest code must
   execute on its owning actor or CONTROL scheduler, never on a reactor.**
3. The normal throughput profile targets **zero VM-owned reactor threads at
   cold startup**. Reactor/scheduler descriptors and bounded queues MAY be
   constructed eagerly, but the first valid readiness admission lazily starts
   reactor #0. Sustained measured reactor pressure may grow the reactor set up
   to a bounded implementation maximum (initial target: four). Pending handle
   count alone is never a scaling signal. An explicit warm/server profile MAY
   prestart one reactor; that is configuration, not a language semantic.
4. Throughput CONTROL, PRIVATE, SHARED and UNTRUSTED execution domains target
   **zero resident carriers at cold startup**. A first carrier is created only
   after independently runnable work is admitted. Hosts MAY opt into an
   explicit nonzero warm minimum, but that is configuration rather than a
   language semantic.
5. Canonical normal-profile completion isolation adds **zero dedicated
   completion-worker threads**. A reactor publishes only bounded immutable
   readiness/completion records; continuation resumption is enqueued to the
   owning scheduler/domain, or to an explicitly supplied host executor for
   host-only callbacks. Reactor threads MUST NOT execute arbitrary Future
   subscribers, and slow subscribers MUST NOT consume/starve CONTROL. A
   backend that still needs a private completion pool is transitional and MUST
   report that implementation gap rather than claim canonical topology.
6. Physical actor/CONTROL carrier capacity is governed by a **VM-wide bounded
   carrier budget**, not four independent thread reservations. Domain maxima
   are admission ceilings. CONTROL must retain guaranteed progress capacity
   (for example one emergency/reserved permit) without requiring a resident
   CONTROL thread. Demand for *runnable* turns can grow carriers; pending I/O,
   actors, ActorGroups, mailboxes and suspended continuations cannot.
7. An **explicitly user-created fixed scheduler** is a deliberate exception to
   ordinary VM-pool laziness. Where exposed (for example Java
   `OresScheduler(N)`), `N` means exactly `N` dedicated user-owned carrier
   threads, created/prestarted because the user explicitly requested them.
   Such a scheduler is never created implicitly per actor or ActorGroup and
   its carriers are accounted separately from the normal VM cold-start
   invariant. A backend without this surface must not emulate it with hidden
   per-object threads.
8. The strict profile forbids blocking-worker/virtual-thread I/O offloading.
   Unsupported socket/file/HTTP/stdio operations reject; they must not silently
   use blocking calls or pretend that an async-looking API is OS-nonblocking.
9. Socket, read/write operation, continuation and completion records are owned,
   bounded, generation-fenced and cancel-safe. A descriptor is admitted by at
   most one active I/O owner; a stale completion cannot settle a reused slot.
10. A VM/guest may use existing OS/JVM/.NET/host event loops when dedicated
   reactor ownership is unavailable, but MUST verify that its guest operation
   is genuinely nonblocking. It MUST NOT claim explicit 1..4 reactor-thread
   control if that platform does not expose it.

## Per-actor physical concurrency

Three distinct limits MUST NOT be confused:

- Logically outstanding message lifetimes (including suspended messages);
- `maxActiveTurns` on a single actor, default **1**, future opt-in **1..3**;
- ActorGroup physical `maxParallelTurns` across *multiple* actors.

A host-only 1..3 credit gate does not enable concurrent guest actors.
The source compiler and runtime MUST prove independent per-turn frames, owned
or Sendable message data, legitimate shared immutable reads, exclusive
`critical` state writes, cancellation/finalizer/lifecycle quiescence, and
Graal/native engine thread safety BEFORE accepting `maxActiveTurns > 1`.
A `critical` loan cannot escape or span await/select/suspension. Contention
must suspend/requeue, not park a carrier. A backend without actors must reject
all actor execution, including a request for a single physical turn.

## Native real-time profile

LLVM and any native RT implementation target zero tracing-GC and deterministic
bounded native lifetimes. Preallocate fixed carrier/reactor sets and bounded
tickets/arenas BEFORE admitting deadline-sensitive work. Do not grow pools,
allocate unboundedly, or block on ordinary locks on the certified hot path.
This alone is **not** a hard-real-time guarantee: platform-specific WCET,
preemption, scheduler priority and device/kernel latency proofs are required.
Backends without proven RT admission must explicitly deny #hard.

## Current implementation classification (2026-10-17)

| Backend | NIO status | Actor physical turns | RT status |
| --- | --- | --- | --- |
| Java/GraalVM | VM readiness starts reactor #0 lazily; full OresContext binds terminal notifications to existing actor carriers. The first runnable bound completion may use one short-lived lazy bootstrap submitter solely to move cold carrier submission/startup off the selector; on the full OresContext path the delivery still executes on the actor carrier, and pending I/O alone does not start the helper. Standalone OresVM/readiness groups retain a transitional lazy private 0..2-worker completion pool. Legacy HTTP/FS paths need migration | Host credits 1..3, live actor default single-flight; opt-in 4..256 global static carrier cap with CONTROL reserve | Hybrid GC; no hard-RT guarantee |
| LLVM | Linux epoll manager configures throughput at zero pthreads and lazily starts reactor #0; native VM attachment exists, source await bridge incomplete | Host credits 1..3, native execution authority still single-owner | Zero tracing-GC substrate and fixed prestart profile; no WCET guarantee |
| .NET | Source compiler/runtime has no guest NIO implementation | Host credits 1..3 only; no guest parallel actor execution | Managed GC; no hard-RT claim |
| WASM | Zero-import scalar guest; no guest NIO or reactors | No guest actor execution, reject physical-turn requests | No hard-RT claim |
| Forge | Mailbox prototype; no guest NIO/reactor | Host credits 1..3 only; no source parallel actor execution | Native/no tracing-GC host credit path; no hard-RT claim |

## Incremental Java enforcement (2026-10-17)

- In a fully constructed Java `OresContext`, the readiness manager is bound
  **before first watch** to the existing actor dispatcher's host-only
  notification execution path. Pending I/O starts no actor or bootstrap
  carrier. When the first terminal notification becomes independently
  runnable, one short-lived lazy bootstrap submitter may start solely to
  submit that first delivery through the cold bound executor off the selector
  stack. On the OresContext ActorRuntime binding the delivery itself executes
  on the actor carrier, not the helper. After that handoff the helper retires,
  and remaining bounded staged notifications execute on actor carriers. Host callbacks
  must never consume CONTROL or selector carriers; guest continuation
  resumption must still be enqueued through the owning actor scheduler.
  This transient bootstrap is a Java implementation gap from a topology with
  no extra handoff thread at all and must remain visible in thread accounting.
- `OresContext.close()` stops and drains NIO before actor dispatchers retire.
  A standalone `OresVM` or `NioReadinessGroup` retains the transitional lazy
  private completion executor for compatibility. Do **not** claim universal
  zero-worker completion topology until standalone users require an explicit
  host executor or an owning scheduler.
- `-Dores.runtime.carriers.global.max=N` (4..256) opts an `OresContext`
  into an immediately enforceable *conservative static* physical-carrier cap:
  CONTROL has one reserved carrier permit, and PRIVATE/SHARED/UNTRUSTED each
  get `floor((N - 1) / 3)` maximum resident carriers. Native lane/affinity
  configurations remain isolated; Java non-affine expansion cannot bypass the
  domain cap. The total possible CONTROL+actor carriers is <= N. Up to two
  permits may remain unallocated. This is **not yet work-conserving**: a busy
  domain cannot borrow idle permits from another, and the legacy unconfigured
  runtime still uses independent per-domain maxima.
- The global execution-carrier cap excludes dedicated kernel readiness
  reactors, Java's bounded lazy lifecycle-observer host workers, and
  user-explicit fixed `OresScheduler(N)` threads. Java exposes lifecycle
  observer worker/backlog counts separately; those workers are zero at cold
  start and currently bounded to four, but they are a documented topology gap
  from a future truly VM-wide physical-worker budget. The execution-carrier
  cap does not certify guest multi-turn actor execution or RT latency.
- These branch changes require current-head JDK 25 Maven/JUnit, Native Image
  and real compiled guest TCP qualification before merge. Existing funded
  exact-blob evidence predates this addition.

## Required differential fixtures

- Throughput cold start: zero VM reactor threads, zero CONTROL/actor carriers
  and zero completion workers. Invalid/rejected I/O admission stays at zero;
  the first valid readiness watch starts exactly one reactor. Pending watches
  alone create no actor/bootstrap carrier. A first runnable bound completion
  may create one transient Java bootstrap submitter; on the OresContext path
  the callback must execute on the actor carrier and the helper must retire
  after cold bound-executor handoff. Five and
  10,000 idle/pending reads must not create proportional threads.
- Independently runnable CPU work lazily creates carriers under one VM-wide
  budget while preserving CONTROL progress capacity; ActorGroups, actors,
  mailboxes and suspended awaits never directly own OS threads.
- Java lifecycle observers start at zero host workers, remain bounded to at
  most four when terminal callbacks block, expose backlog explicitly, and
  never execute on actor/CONTROL/selector carriers. Until those workers are
  folded into the VM-wide physical budget, record them as a separate topology
  resource rather than claiming the execution-carrier property covers them.
- If a backend exposes a fixed user scheduler, constructing it with `N`
  explicitly creates exactly `N` user-owned carriers; creating ActorGroups or
  ordinary runtime schedulers never does so implicitly.
- Concurrent connect/accept/read/write, partial writes, EOF, cancel/close
  races, generation/descriptor reuse, fd ownership and bounded backpressure.
- A reactor publishes completions only; guest callbacks run on the owning
  scheduler. Idle/reactor shutdown never strands accepted operations.
- Default one physical actor turn; opted-in three safe DATA turns, denied fourth,
  state read/write loan safety, correct CONTROL/stop/panic priority and teardown.
- Explicit unsupported-feature denial on .NET/WASM/Forge until source lowering
  exists. Do not count host-only credit or NIO tests as source guest success.
- LLVM RT: zero tracing-GC, preallocated hot-path resources, bounded worst-case
  latency measurement under saturation, clear rejection of unproven #hard,
  and a pthread-ID census proving no new runtime thread appears after the RT
  admission fence.

## Evidence and source handling

Record immutable PR head commit, source Git tree, exact tested blob/tree,
runner job/step execution, compiler flags, and source-level guest tests.
A zero-step GitHub Actions failure proves neither pass nor fail. An exact-blob
host test establishes only that slice; it is not full source-tree parity.
Private cross-org source transfers require a reviewed protected-main approval
for the specific private destination, independent of Actions minutes.

## Canonical source API: actor-local physical turn maximum

The following built-in enum has fixed values. A backend may recognize its
canonical declaration without supporting unrestricted user-defined enums.
No source package or user module may redefine its values.

```oreslang
define enum MaxActorThreads as
    LOW int = 1     // default: one physically executing actor turn
    MEDIUM int = 2
    HIGH int = 3
end
```

The language-owned enum is implicit when omitted from the file. The actor
declaration annotation is **not** a runtime thread creation request:

```oreslang
@ActorMaxThreads(MaxActorThreads.LOW)
define actor NormalActor as
end
```

The following illustrates the **future opt-in** for a hungry actor; until
the compiler and runtime provide independent per-turn state and proven
mutable access control, every backend MUST reject it before executing
guest code or emitting a runnable artifact:

```oreslang
@ActorMaxThreads(MaxActorThreads.HIGH)
define actor HungryActor as
end
```

- `LOW=1` is the default for every source actor (annotated or not).
- `MEDIUM=2` and `HIGH=3` are hard upper limits on **simultaneously
  physically executing DATA turns in a single actor**, not guarantees of
  assigned/resident threads. No dedicated per-actor thread pool is implied.
- Outstanding/suspended messages do not consume a physical turn.
- `ActorGroup.maxParallelTurns` remains an independent aggregate bound.
  Effective admissible turns must satisfy BOTH the actor-local and group
  bounds, and the actual available shared execution carriers.
- Unknown enum members, ordinal substitutions (e.g. `HIGH=4`), duplicate
  annotations/enum declarations, non-actor targets, literal numeric annotation
  arguments, or MEDIUM/HIGH without compiler-proven isolation MUST be rejected.
- A source actor without `@ActorMaxThreads` is behaviorally identical to
  `@ActorMaxThreads(MaxActorThreads.LOW)`; serial actor aliases remain serial.
- The actor's protected `state { ... }` map remains the sole actor-instance
  mutable state channel. `critical` writes require an exclusive state loan
  across all concurrently executing turns. No mutable loan crosses await.
- Java/GraalVM and LLVM accept and validate the enum/LOW annotation on their
  staged branches; LLVM source actor syntax remains narrower than Java.
  .NET/Forge/WASM explicitly deny all source actor tiers until they implement
  real guest actor scheduling. Host-only 1..3 credit gates are insufficient.
