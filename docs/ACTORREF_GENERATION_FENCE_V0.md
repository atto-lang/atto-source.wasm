# Host-only ActorRef generation and admission fence — v0

**Experimental trusted local OresVM host boundary; not native/WASM
cross-process ActorRef parity.** Builds on pooled-worker PR #151, actual-source
PR #154, and native/WASM typed DATA loopback PR #158.

## Design

`NativeWasmActorRegistry` wraps an **exclusive**
`PooledWasmActors` instance, controlling the only exposed host route to
its actor handles. A registry mints opaque frozen empty objects. Authority
exists solely as `WeakMap` entries created inside the registry; the ref
contains **no serialized ID, token or capability field**. Fabricating a ref,
cloning an object, mutating an object, or copying a JSON `{}` value cannot
produce authority. The private entry binds a random logical actor identity,
an integer generation, a random incarnation and rights.

`attenuate` can create send-only or stop-only descendant refs but cannot
increase permissions. Revoking an ancestor transitively invalidates descendants.
The host limits delegation chains to depth 64 and total grants to 4,096 per
actor incarnation. Neither JS garbage collection nor revocation is treated as
a synchronous grant quota refund; both depth and lifetime grant admission fail
before minting the new reference.
Ref validation always re-checks identity, generation, incarnation, permissions
and current actor lifecycle before admitting work.

`send(ref, ticket, value)` only accepts positive bounded signed-i64 tickets
and signed-i64 scalar values. A per-incarnation high-water mark rejects
out-of-order or duplicate tickets. An admitted ticket is consumed **before
the first suspension**; if a physical guest's outcome is uncertain, its
ticket is never reused. The broker limits outstanding accepted sends and
reserves concurrent spawn slots before awaiting `pool.spawn`.

Rotation is a **root-supervisor-only** privilege even when a delegated ref
has both send and stop rights. A delegated stop-only ref may terminate an actor
but never mint a replacement full-rights ref. Revocation is rechecked after
the asynchronous stop and after successor spawn. If authority disappears while
the successor is being created, the successor is never published and its stop
must be confirmed; uncertain cleanup retains a quarantined runtime handle.

`stop(ref)` seals new DATA and grants **synchronously**, then waits for
the pooled runtime's stop acknowledgment. On stop failure it retains the
retirement-unconfirmed actor entry. `rotate` first waits for confirmed stop
then creates the new guest with a larger generation and new incarnation;
old refs never gain access to that instance. It holds a capacity reservation
during retirement. On close failure the registry retains uncertain entries
rather than declaring their memory reclaimed.

## Local process DATA integration

`src/native-wasm-pipe-v0.mjs` owns the registry. Incoming native C++ messages
contain **only** the pinned MessagePack v2 `T[I,I]` DATA tuple
`[ticket, i64_value]`. The host independently selects a pre-minted ActorRef
from its private actor roster and calls `registry.send(ref,ticket,value)`.
No incoming bytes are interpreted as an ActorRef; there is no DATA channel
capability grant and no CONTROL operation exposed through this wire profile.
The native C++ side is still a trusted *wire peer*, not an actual
source-compiled native OresVM actor. The WASM guest is still synchronous
scalar-only, and the pooled Worker is not an OS security sandbox.

This is a **local capability validation** layer, not cryptographic authentication
of remote actor references. Random identity and WeakMap membership do not make
an authenticated cross-process transport or a protected untrusted execution
domain. A future native actor bridge needs a versioned, authenticated
generation/rights envelope, trusted broker identities, replay-fenced sessions,
compiler-proven Sendable/Serializable, atomic copy/move ownership admission,
separate runtime-minted supervisor CONTROL and physical continuation leases.

## Tests and release gates

`node --test tests/actorref-registry-v0.test.mjs` covers forged and cloned refs,
attenuation and escalation, hierarchical revocation, signed-i64 DATA admission,
monotonic ticket/replay fences, independent actor histories, bounded pending
sends, stop races, fresh-generation rotation, failed retirement, failed close,
and concurrent spawn capacity reservations. No real source compiler is needed
for these isolated registry tests; the underlying pool is a deliberately
controlled fake. Only an **actual source-compiled WASM actor running in the
real pooled runtime**, plus the real native C++ process, satisfies the larger
`npm run test:native-wasm-loop` acceptance gate.

The source tree is private. All test claims must identify the exact HEAD,
toolchain, executed counts and authentic cross-process boundaries. A workflow
failing before its first step is **NOT_EXECUTED**. Never promote, merge or
transfer private Git trees to an unapproved carrier based on mock tests,
zero-step checks, or file SHA pins alone.
