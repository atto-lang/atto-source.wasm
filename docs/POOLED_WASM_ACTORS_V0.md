# Fixed-carrier WASM actors v0 (experimental, trusted-only)

Oreslang WASM targets **full OresVM parity**, plus native OresVM actor transport.
One actor must **not** entail one pthread/OS Worker. The initial building block
`PooledWasmActors` in `src/pooled-actor-host.mjs` assigns many separate,
private `WebAssembly.Instance` objects to at most four fixed Node Workers.
Each carrier executes only one synchronous actor turn at a time and dispatches
admitted work in actor round-robin order. The actor count can exceed the Worker
count. State persists across messages and cannot be directly accessed by another
actor. Bounded mailboxes count queued **and executing** messages.

This is an **internal trusted-scalar integration slice**, not a full OresVM or
safe sandbox for untrusted WASM. `spawn` requires `trusted: true` and an exact
SHA-256 artifact pin. That flag is a local API assertion, **not a security grant**;
the caller must independently authenticate the compiler, artifact and deployment
policy. Never expose this API to guest-controlled code.

## ABI and execution contract

Each actor owns one import-free WASM32 module instance with a private fixed
2-page linear memory and exactly these exports:

- `oreslang_wasm_actor_init() -> void`
- `oreslang_wasm_actor_on_message(i64) -> i64`
- `oreslang_wasm_actor_teardown() -> void`
- `memory`

The worker uses the existing bounded core-WASM byte inspector; start functions,
imports, tables, shared memory, memory64, managed reference types and extra
exports are denied. A transport operation is keyed to an unguessable
incarnation and monotonic ticket; malformed/stale carrier receipts terminate
the **affected Worker carrier** and all actors pinned to it. Teardown zeroes
guest linear memory before acknowledging normal retirement.
A guest trap or uncooperative CPU loop quarantines its Worker, not the entire
pool. Other healthy carriers remain available and new actors may be routed to
them. Success/failure of work on the failed carrier is settled only after
physical Worker termination; colocated actors necessarily lose their state.

## Explicit limitations and follow-up

This ABI accepts **only scalar i64 messages**. It does not implement source
`spawn/send`, arbitrary typed MessagePack envelopes, ActorRef transport,
DATA/CONTROL supervisor separation, async/await, stack switching, pinned
continuations, borrow revalidation, native actor bridging, filesystem/network
capabilities or hot generations. There is no host import broker, no WASI, and
no OS sandbox. Current synchronous turns cannot be preempted and *resumed*:
Worker termination on timeout is a terminal failure, not a safepoint.

Next gates: compiler-emitted explicit cooperative safepoints and resumable
state machines; versioned typed envelopes and native OresVM bridge; bounded
supervisor CONTROL with restart/quiescence receipts; a process-isolated
untrusted deployment profile; full real-source actor conformance and exact-head
Node plus Wasmtime AOT evidence. Do not claim full WASM language parity until
these gates execute successfully.

Default test entry: `node --test tests/pooled-actors.test.mjs` (Clang wasm32
required); included automatically in `npm test`.


## Carrier termination and lifetime fencing (audit hardening)

Worker termination is a **physical retirement boundary**, not merely a
logical mailbox closure. Even a synchronous `Worker.terminate()` exception
must not prevent attempts to terminate remaining carriers. The host requires
an awaitable Node Worker termination receipt and waits for **all** carrier
termination attempts before settling accepted work.

If any carrier termination fails or returns no awaitable receipt, the
shutdown operation rejects with `actor carrier termination unconfirmed`.
The host retains the corresponding actor identity and lifetime references
instead of clearing the actor registry or allowing a new incarnation.
Outstanding sends reject, but their rejection is **not** a proof of
reclaimed guest memory. The current API deliberately offers no automatic
retry or reclamation after unconfirmed carrier termination; operators must
establish an independent physical quiescence barrier.

`tests/pooled-actors.test.mjs` injects both synchronous-throw and missing
termination-receipt failures. These tests validate fail-closed lifecycle
accounting and do not substitute for an OS sandbox or certified recovery.


## Pre-carrier artifact admission (2026-10-27)

The parent host now verifies **the same snapshotted, SHA-256-pinned bytes**
before creating an actor ID or enqueueing INIT on any shared carrier. The
preflight runs the repository's bounded core-Wasm scanner, enforces one
non-shared, fixed two-page linear memory, and checks the exact three-function
actor ABI from the binary function/type/export sections. Malformed modules,
imports, wrong signatures, and invalid memory limits reject the `spawn`
request **without poisoning already-running peer actors**.

The Worker independently repeats core-Wasm validation and the exact ABI
check on its received private snapshot. Preflight is a safety boundary
against an ordinary malformed artifact, not authorization to execute
untrusted guest code or protection from malicious native engine defects.
A guest trap or noncooperating callback quarantines only its Worker,
retiring all actor instances colocated there after an independently confirmed
termination receipt. Other Workers continue, but no Worker is automatically
replenished. Browser/Node cooperative continuation lowering and OS-process
isolation for untrusted actors remain separate required milestones.

## Per-carrier fault containment (2026-10-27)

The pooled host now tracks carrier liveness separately from actor state.
`activeWorkerCount` reports surviving Workers, whereas `workerCount` reports
the original fixed number. On a trap, timeout, invalid receipt or unexpected
Worker exit, the affected carrier is marked unavailable immediately and
cannot acknowledge more turns. Colocated actors are sealed; pending DATA
settles only after physical Worker termination is confirmed. Failed physical
termination retains the actor identities and rejects work **without** allowing
their memory/lifetime to be reclaimed or their carrier to be reused.

Other live carriers retain their actors and continue processing. New spawns
choose only live carriers. No automatic Worker respawn, actor recovery,
migration, typed supervisor CONTROL or resumable preemption is implemented.
The shared Worker is a trusted-only common failure domain for its actors.
The test suite covers a spinning actor, a second live Worker, colocated
failed actors, live-Worker replacement admission, and delayed termination
receipts without early settlement.
