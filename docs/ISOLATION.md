# Execution isolation contract and staged roadmap

## Admitted today: experimental scalar profile

`core-wasm.i64-v1` requires:
- core Wasm validation and exact `() -> i64` exported function;
- **no host imports**, start section or table section;
- exactly one private 32-bit linear memory, explicitly limited at link time to at most two 64-KiB pages by default;
- no shared memory, memory64, multi-memory, or unbounded expansion;
- required SHA-256 pin in the CLI (optional only for direct API callers performing local controlled tests), checked against an immutable execution snapshot;
- no WASI, clock, filesystem, network, environment variables or device host bindings;
- worker startup clears inherited environment variables and Node execution flags;
- fresh Node worker per execution; validation, compilation, and guest execution happen inside the worker's wall-time deadline;
- admission cap of four live workers per main-thread module instance, with capacity released after termination.

This prevents guests from invoking unauthorized JS host imports through WebAssembly and prevents the normal guest linear-memory address space from being shared between invocations. It is a **defense-in-depth prototype**, not containment against vulnerabilities in the Wasm engine or operating system.

Memory maximum is checked against the binary, not just build flags. CLI file reads are capped before allocation, and the CLI requires an exact artifact SHA-256 pin. The standalone admission helper verifies that pinned hash on a byte snapshot before invoking the WebAssembly validator or compiler. Untrusted compilation runs within the disposable worker, not on the main thread. Node worker JS heap resourceLimits do not constrain all WASM/non-JS native allocations; the module-size, fixed guest linear-memory maximum, time deadline and OS-level deployment boundaries still matter.

## NOT proven

- Not a true Oreslang actor: no actor lifecycle, authenticated ActorRef, async continuations, mailbox protocol or transfer of an ownership-protected Oreslang heap.
- Not Native AOT: Node/V8 may compile core Wasm just in time.
- Not an OS sandbox: native Wasm execution remains in the same OS process as other workers.
- Not general Wasm Component Model or WASI 0.2/0.3 support.
- Not native CPU fuel metering; worker termination is a wall-time guard and can be delayed if the host event loop is blocked. The API does not report success or release a worker slot until termination completes.
- The four-worker admission cap is module-local, not a per-tenant or per-process aggregate quota across every Node context.
- Not a verified shared frontend or formal proof of semantic parity with other language backends.

## Next boundaries

1. Consume versioned, verified Oreslang MIR from a common frontend instead of duplicating parsing/type/borrow logic.
2. Stabilize actor message ABI (bounded serialized payloads, authenticated actor handles, generation IDs, ownership/borrow discipline, cancellation).
3. Define capability/effect manifest; enforce at source checker, link/import gate, and trusted host broker.
4. Add isolated actor instances and deterministic mailbox/continuation semantics, with each actor's private memory.
5. Add Wasmtime-based strict AOT host (precompile under trusted build conditions, pin host compatibility, reject untrusted serialized native artifacts) and OS process sandboxing for hostile tenants.
6. Add WIT component APIs with separate pinned WASI 0.2/0.3 profiles; no direct raw pointers across actor domains.
7. Attach real compiler binaries to `oreslang-platform-conformance` and test inter-backend behavior, not just harness self-tests.
8. Add fuzzing, differential compilation, crash/timeout, memory-exhaustion and formal state-machine checks.

CI should never treat stub compiler tests as evidence of Oreslang-to-Wasm actor support.

## Compiled module identity

The worker instantiates precisely the one WebAssembly.Module compiled from the
fully admitted immutable byte snapshot. It must not compile again using a
separate mutable view after admission. The legacy `admitCoreGuest` API still
returns only frozen validation metadata; the execution-specific helper returns
the compiled module privately to the disposable worker.

Host environment and execution-argument stripping are defense in depth, not
protection from native engine vulnerabilities. Process isolation is still
required for hostile tenants.

## Shared-buffer and worker-reply admission (October 2026)

The scalar input boundary rejects all `SharedArrayBuffer`-backed views,
including cross-realm objects. Hashes are computed only from private byte
snapshots. No user-owned backing buffer is transferred to a guest worker.
The parent also validates the complete worker-reported admission envelope
(version, profile, function entry, input size, SHA pin if present, fixed-memory
budget and zero capabilities) before returning a successful result. These
checks prevent accidental success from inconsistent internal metadata but
do not turn the Node Worker API into an OS-level security boundary.

## Host actor arena: one memory address space per actor

The experimental actor arena MUST NOT implement actor isolation by giving
different actors slices of a single `WebAssembly.Memory`: a raw `i32.load`
inside any guest with access to that memory can address other actors' slices.

The arena uses a **distinct non-shared `WebAssembly.Memory` instance for
each simultaneously live SHARED/PRIVATE/UNTRUSTED actor**, initially fixed to
two 64-KiB pages (persistent and scratch). Every actor sees logical offsets
relative to its own instance, not offsets within a process-global pool. A
fixed-capacity runtime pool retains **entire** memory instances. After a
retiring actor finishes its turn and bytes are scrubbed, its instance may be
reissued to another actor without host GC or `Memory.grow`. Pooling is only
of capacity, never concurrent address spaces. Fixed 2-page configurations
cannot grow; a future variable-size allocator needs size-classed instances,
explicit bounds and budget controls, and retirement pin checks. No resident
physical page decommit is promised.

The current `ActorArena` now supports a **restricted synchronous Wasm
guest binding** through `attachGuest(turn, wasmBytes)`,
`invokeGuest(turn, binding, exportName, ...scalarArgs)`, and
`detachGuest(binding)`. The guest module imports exactly
`env.memory` from that actor's independent heap; it cannot import any
host callbacks, export the memory, define another memory, or declare
start/table/element/tag sections. The host neither exports the
`WebAssembly.Instance` nor exposes the `Memory`, `ArrayBuffer`, or a
reusable address base. Every binding holds an arena-lifetime pin; detaching
after all *synchronous* calls end releases the pin, including after CONTROL
closes admission. Late calls or stale/foreign bindings fail closed.

Because the direct guest invocation has no instruction-fuel meter or
preemption, `attachGuest` **rejects UNTRUSTED actor kinds**. Untrusted
actors still have independent host-owned memory, but must execute actual
Wasm code only in a separately isolated worker/runtime with an enforced
termination deadline. Trusted synchronous guest execution itself is not a
hard-real-time or arbitrary-loop-safe primitive.

This narrowly verified, synchronous Node/Wasm bridge is NOT yet
source-level Oreslang `define actor` execution, an async guest runtime or
a browser/Wasmtime ABI. The older, zero-import scalar profile remains
separate and unchanged.

Before connecting real Oreslang actor scheduling or continuations, integration MUST:

1. Bind exactly one guest module instance to its own independently isolated
   linear memory (internal defined/exported memory or a verified single-actor
   imported memory; do not accidentally give a module a shared pool memory).
2. Join and drain all actor tasks, continuations, FFI pins, live module
   instances, and aliased views before returning a memory instance to the
   runtime pool. A merely dropped host handle or completed mailbox turn is
   insufficient once guest instances exist.
3. Issue unforgeable owner/incarnation and allocation-lifetime evidence.
   A raw `u32` compressed offset is not a cross-actor capability.
4. Reject cross-actor memory imports and prevent naked offsets in mailbox or
   serialized payloads. Authenticated `ActorRef<T>` and copied/moved messages
   are distinct authorities.
5. Prove that an untrusted guest has no access to the JavaScript host-side
   pool or any sibling memory; a Worker provides scheduling separation, not
   OS-process isolation.

A focused regression instruments actor Memory creation and instantiates real
Wasm `i32.load8_u` code against each independently created instance. It
demonstrates that equal local addresses resolve to different actors' values.
The privileged test instrumentation is **not** an API exposed to guests;
its synthetic guest instances must be discarded before testing retirement
and memory reuse. The test does not establish end-to-end Oreslang source
compiler lowering or guest instance quiescence.

### Retirement admission and lifetime pins

The host arena exposes an **opaque actor-lifetime barrier**, not a guest
memory capability: `pinLifetime(turn)` and `unpinLifetime(turn, pin)`.
The lifetime barrier persists across mailbox turns, is bound to a specific
arena instance, rejects foreign/forged/stale/replayed permits, and has a
4096-per-actor admission bound. `requestRetirement()` closes admission to
new turns and new pins, while allowing an existing turn to finish. Existing
permits are released using `unpinLifetime(pin)` WITHOUT entering a new
actor turn, including during shutdown. `retire()` fails closed while a turn
or lifetime pin remains active. Only after both conditions are satisfied
may the actor memory instance return to the reusable pool.

The trusted CONTROL/scheduler must hold these barriers for every persistent
continuation, in-flight message payload accessor, remote/FFI handle and
guest instance that might retain actor bytes. A memory token alone does not
prove external quiescence. The runtime must only release it **after** the
external operation has completed or the guest instance/worker is definitively
terminated; cancellation requests and merely clearing a JavaScript variable
are NOT sufficient. The host-only implementation currently has no actual
guest-memory binding, so full lifecycle integration and forced-termination
proofs are separate prerequisites before exposing actor Memory to compiled
guest code. The pin API intentionally never returns the underlying memory.

Adversarial native-Wasm tests cover real `i32.load8_u` reads, three
simultaneous distinct actor memories, cross-domain/stale access denial,
96 concurrent actors with interleaved retirement/reissue, and lifetime
permit forgery/double-release/foreign release/turn transfer. The replay
regressions exercise a host-only boundary and do not constitute a full
Oreslang compiler/guest-lifecycle proof.

### Current-main restricted guest tests

`tests/actor-guest-binding.test.mjs` runs actual `WebAssembly.Instance`
programs with real `i32.load8_u` against different live actor heaps. The
test verifies equal guest offsets read different per-actor values, revoked
bindings cannot execute after detach, a bound guest blocks memory recycling,
and zeroized memory is safe for subsequent actor admission after release.
The admission policy uses a one-time private byte snapshot before compilation,
permits only an `env.memory` import, forbids memory exports/start sections,
and captures native constructors/export accessors to resist mutable JavaScript
prototype hooks.

A malicious caller retaining a native guest instance or its `Memory` can
still access a recycled heap. The bridge's security argument **depends**
on never returning either native capability and on admitting no host function
imports or asynchronous guest continuations. The moment async callbacks,
FFI, or source-level guest actor capabilities are introduced, CONTROL MUST
prove every external instance and pin quiesced, or disable memory pooling
for guest-bound heaps. Process/Worker isolation remains a separate gate.
