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
the pool. Teardown zeroes guest linear memory before acknowledging retirement.
A guest trap or uncooperative CPU loop terminates the entire carrier pool, not
just the current actor. Success/failure is settled only after Worker termination
when a carrier must be killed. The application must account for collateral
loss of other actors on that carrier and restart from known states.

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
