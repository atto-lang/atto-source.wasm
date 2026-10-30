# Callback dispatch, execution context, and tracing — v1

Status: normative cross-backend runtime contract. Backend substrate conformance is distinct from source-language async/await parity.

## Identity model

1. **Active execution context is authority.** It identifies guest code currently admitted by an Ores scheduler/actor turn. It may carry actor/task allocation authority. It is never inferred from an OS thread.
2. **Callback context is provenance only.** A callback registration may capture immutable logical ancestry and trace identifiers. Installing that snapshot around host completion bookkeeping does not grant actor state, heap, permission, scheduler, or guest-entry authority.
3. **Physical carrier identity is not semantic identity.** Await/resume, actor delivery, timers, I/O, JNI/FFI, worker messages, and host Task/Promise completions may arrive on another thread/worker. Producer ambient context is ignored.
4. **Lineage and execution segment are separate.** A logical task/actor lineage survives suspension. Every resumed guest segment enters through a fresh dispatch/turn identity after the prior guest boundary has unwound. Backends may represent lineage and segment identities differently, but must preserve this distinction.
5. Allocation domains are independent from execution/callback identity. A callback snapshot can retain a lifetime pin needed for safe completion, but it cannot itself read or mutate actor-owned storage.

## Capture and restoration

1. Capture occurs explicitly at callback/await registration or scheduler suspension. Never inherit arbitrary host thread-local / AsyncLocal / worker-global state by accident.
2. Captured records are immutable values or generation-checked opaque handles. Native persisted records contain no native stack pointer.
3. A callback may install its captured provenance only while performing host-only resolution/bookkeeping. Nested callback scopes restore the exact previous scope in LIFO order, including exception paths.
4. Callback scope must be cleared before returning to an unrelated host event-loop turn, thread-pool item, reactor callback, or worker message.
5. Reusing a stale generation, retired actor incarnation, released continuation, or already-consumed one-shot callback token fails closed.

## No-Zalgo completion and resume

1. A Future/Task/Promise/callback may settle synchronously before registration returns. Settlement may CAS terminal state, release accounting, and enqueue a bounded wake ticket; it may not run Oreslang guest code inline.
2. Guest continuation code resumes only after the suspending guest turn has fully unwound and only through its owning scheduler/actor admission path.
3. A completion thread must never impersonate the suspended execution by installing the active execution context. It may expose only callback provenance to tracing/runtime diagnostics.
4. Completion races are exactly-once: success, failure, timeout, cancellation, or close has one winner. Duplicate producer callbacks are diagnosed; a first callback arriving after consumer cancellation may be dropped without reviving work.
5. Waiter registration versus already-terminal observation must have no lost wakeup and at most one resume.

## Trace semantics

1. Logical traces compose active native/JVM/.NET/JS frames with bounded execution ancestry and continuation/callback boundaries.
2. Required boundary kinds are `AWAIT`, `HOST_CALLBACK`, `TIMER`, `IO`, `ACTOR_MESSAGE`, `SUPERVISOR_CONTROL`, `TASK_JOIN`, and `SPAWN`. Unsupported backends may fail closed before source admission, but runtime substrate must not relabel one boundary as another.
3. External tracing integration (for example OpenTelemetry) carries trace/span identifiers and flags by immutable value. Runtime callback context must not retain mutable tracer/span provider objects or use them as execution authority.
4. Trace truncation is explicit. A zero rendering budget must not make the runtime claim that no logical ancestry exists.
5. Failure rendering must preserve the originating logical lineage across carrier migration and must not attribute a producer I/O thread as the guest execution owner.

## Cancellation, teardown, and lifetime

1. Cancellation detaches callback/waiter retention and revokes future guest resume authority, but physical FFI/I/O/worker completion may still retain a bounded lifetime pin until the host operation actually exits.
2. Context/actor shutdown seals new callback admission before reclaim. Late callbacks may release pins and publish diagnostics, but cannot resurrect a retired context, actor generation, continuation, or allocation domain.
3. Resource release and callback notification are separate obligations. A settled Future alone is not proof that a native descriptor, DMA/FFI loan, worker turn, or callback body has physically exited.
4. Callback exceptions cannot skip mandatory accounting release. Fatal host signals keep backend-specific fatal semantics but do not authorize guest reentry.

## Allocation discipline

- LLVM/native and Forge callback-context records must be fixed-size/value or bounded-store entries and support allocation-free steady-state dispatch where the surrounding scheduler does.
- Java/GraalVM should capture one immutable snapshot per genuinely escaping callback registration and reuse it for resolution; no wrapper allocation per waiter invocation is required.
- .NET Native AOT should use value records and explicit scoped restoration; do not rely on ambient `ExecutionContext` flow as Oreslang authority.
- WASM/JS uses explicit values carried in host/worker messages or closure state; browser support must not depend on Node-only ambient context APIs.

## Minimum adversarial conformance

Each backend substrate must cover: synchronous resolve during registration; cross-thread/worker resolve; nested callback scopes; callback throws; duplicate resolve; cancel-vs-resolve; terminal-before-waiter race; stale generation; actor/context retirement before late callback; callback context cannot grant active execution authority; fresh resume dispatch; trace boundary preservation; callback-scope cleanup; and bounded/no-leak waiter retirement.

## Backend mapping

- Java/GraalVM: `OresContext` + `OresScheduler` own guest admission; `ExecutionContext` is logical task/actor identity; callback provenance is separate from `CURRENT_EXECUTION_CONTEXT`.
- LLVM: generation-checked `ExecutionContextStore` / `ContinuationStore` own persisted ancestry; resume may mint a fresh execution segment while retaining lineage through handles.
- .NET: runtime-owned value context is explicit around host callback bookkeeping; CLR `ExecutionContext`/`AsyncLocal` flow is not sufficient evidence of Oreslang semantics.
- WASM: host/Worker messages carry explicit callback provenance; worker-global ambient state cannot authorize a guest turn.
- Forge: native value context/RAII scope carries provenance; actor turn/lifetime capabilities remain separate.

Source-language parity additionally requires real compiler lowering for async/await/callbacks on the backend. Host-only substrate tests must not be reported as full guest parity.
