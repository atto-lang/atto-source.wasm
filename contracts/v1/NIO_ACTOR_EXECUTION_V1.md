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
3. The throughput profile targets one reactor at startup and allows up to four
   configurable reactors based on sustained measured work, NOT the number of
   pending I/O handles. Five idle reads must not allocate five threads.
4. Independent CONTROL and actor pools have bounded runnable queues, explicit
   rejection/backpressure, and configurable carrier limits (nominal max 20).
   Demand for *runnable* turns can grow carriers; pending I/O cannot.
5. The strict profile forbids blocking-worker/virtual-thread I/O offloading.
   Unsupported socket/file/HTTP/stdio operations reject; they must not silently
   use blocking calls or pretend that an async-looking API is OS-nonblocking.
6. Socket, read/write operation, continuation and completion records are owned,
   bounded, generation-fenced and cancel-safe. A descriptor is admitted by at
   most one active I/O owner; a stale completion cannot settle a reused slot.
7. A VM/guest may use existing OS/JVM/.NET/host event loops when dedicated
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

## Current implementation classification (2026-10-16)

| Backend | NIO status | Actor physical turns | RT status |
| --- | --- | --- | --- |
| Java/GraalVM | Experimental NIO TCP; VM readiness manager; legacy HTTP/FS adapters still need migration | Host credits 1..3, live actor default single-flight | Hybrid GC; no hard-RT guarantee |
| LLVM | Linux epoll reactor + native VM attachment; source await bridge incomplete | Host credits 1..3, native execution authority still single-owner | Zero tracing-GC substrate and prestart profile; no WCET guarantee |
| .NET | Source compiler/runtime has no guest NIO implementation | Host credits 1..3 only; no guest parallel actor execution | Managed GC; no hard-RT claim |
| WASM | Zero-import scalar guest; no guest NIO or reactors | No guest actor execution, reject physical-turn requests | No hard-RT claim |
| Forge | Mailbox prototype; no guest NIO/reactor | Host credits 1..3 only; no source parallel actor execution | Native/no tracing-GC host credit path; no hard-RT claim |

## Required differential fixtures

- One VM reactor at startup; five and many pending reads without proportional
  OS thread creation; independently runnable turn saturation scales workers.
- Concurrent connect/accept/read/write, partial writes, EOF, cancel/close
  races, generation/descriptor reuse, fd ownership and bounded backpressure.
- A reactor publishes completions only; guest callbacks run on the owning
  scheduler. Idle/reactor shutdown never strands accepted operations.
- Default one physical actor turn; opted-in three safe DATA turns, denied fourth,
  state read/write loan safety, correct CONTROL/stop/panic priority and teardown.
- Explicit unsupported-feature denial on .NET/WASM/Forge until source lowering
  exists. Do not count host-only credit or NIO tests as source guest success.
- LLVM RT: zero tracing-GC, preallocated hot-path resources, bounded worst-case
  latency measurement under saturation and clear rejection of unproven #hard.

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
