# Durable Object Tenant Queue Contract v1

**Status:** provisional host-runtime semantic parity contract. It is NOT an enabled Oreslang guest ABI, durable database, distributed lease, OS sandbox, or proof of compiler execution. Canonical public design: [oreslang-durable-objects.ores PR #1](https://github.com/ores-truffle-oreslang/oreslang-durable-objects.ores/pull/1); LLVM reference: [PR #1169](https://github.com/ores-truffle-oreslang/oreslang-source.llvm/pull/1169).

## Key space and isolation

- One logical `IsolateVM` domain per tenant incarnation. Different tenants may use the same numeric `LockId`, `ActorId`, and `OperationId` without sharing queues.
- Ticket identity = issuer-bound isolate generation + lock ID + monotonically unique sequence + operation ID + actor ID and actor incarnation. An untrusted guest may **never** manufacture a ticket or authorize actor identity by supplying these integers. Host-facing adapters must verify an issued actor capability first.
- A tenant owns multiple bounded FIFO queues, each identified by `LockId > 0`; exactly the head is eligible to claim. An actor can own at most one claimed turn across **all** queues, even when lock IDs differ. Other actors with distinct locks may claim concurrently.
- Limits: max live locks, total queued+claimed entries, per-lock depth, and total admitted payload bytes; bound overhead for indexes too in production. Failed admission must not charge credits or increment sequence. No blocking OS locks around user callbacks.

## Lifecycle

1. `enqueue(actorCapability, lockId, operationId, bytes)`: admit if tenant Running and within all limits. Duplicate operation IDs *while pending* are rejected (persistent dedup is separate).
2. `claim(ticket)`: only the exact unclaimed FIFO head; return `false` if that actor is already executing behind another lock, otherwise reserve actor ownership. A stale, forged, replayed or non-head ticket is rejected. Never invoke guest callback while holding queue's bookkeeping mutex.
3. `finish(ticket)`: only a claimed head, **after actual physical callback/continuation/I/O retirement**; frees credits and returns next FIFO head to a scheduler. The host queue alone cannot prove the caller retired physically.
4. `cancelWaiter(ticket)`: removes a non-head not-yet-claimed waiter. `cancelHead(ticket)`: removes an unclaimed head. A claimed head must finish after retirement; it cannot be canceled as unstarted.
5. `beginShutdown`: reject enqueue and claim; permit finish/cancellation while draining. Actor retirement requires zero queued or executing tickets. Tenant destruction requires empty queues **and** zero independent execution/IO/continuation pins.
6. Recreating a tenant or actor yields a new incarnation and invalidates old tickets; no automatic nested Future/Option flattening and no actor handler reentrancy.

## Durability and threat model

These queues are **ephemeral scheduling state**, not persisted event logs. Storage commits, durable inbox/outbox, idempotency ledger, alarms, recovery and distributed epoch/lease fencing must be separate transactional services. Durable identity is (authenticated tenant, namespace, object ID); never restore raw actor pointers/tickets from a database.

Java/GraalVM, LLVM/Forge native, .NET NativeAOT, Wasmtime Store/Instance, and Node Worker isolation have distinct security properties. None may advertise hostile native-tenant crash containment based on an in-process queue. Require real authenticated OS sandbox workers for hostile native code. No unapproved cross-organization private-source CI mirrors.

## Parity fixture

`contracts/v1/durable-objects/queue-v1.json` defines the common behavioral cases. A backend **passes implemented substrate parity** only when a native runtime test actually executes and reports every fixture invariant. Copying these documents is **not** runtime parity. A compiler-backed .ores API and transaction/crash-recovery conformance are separate, still-blocking layers.
