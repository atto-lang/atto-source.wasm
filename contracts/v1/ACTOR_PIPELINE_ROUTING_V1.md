# Oreslang actor pipeline routing v1 — five-backend conformance contract

**Semantic target**, not a claim of implementation parity. Identical rules apply
to .java (GraalVM), .llvm, .net, .wasm and .forge. Compiler acceptance of
`self.*` is **forbidden** until a real guest-lowered actor runtime satisfies
ownership, message admission and single-flight execution in that backend.

## Topology and identity

- A supervisor publishes a typed DAG with **2..1024** distinct actor
  **instance** IDs and **1..4096** distinct directed edges. Nominal actor
  class names may repeat; instance IDs must not.
- Instance ID, actor type and nominal payload name are valid strict UTF-8,
  contain no NUL, are nonempty and at most **256 encoded bytes**. An
  optional inbound/outbound type may be empty only for the corresponding
  missing port. Edges must match the exact nominal output/input payload type.
- `readable`: outgoing only, no inbound; `writable`: incoming only,
  no outbound; `transform` and `duplex`: both typed ports.
- A `transform` must have at least one **actual connected inbound edge** and
  at least one **actual connected outbound edge**. Merely declaring a typed
  output port does not make a terminal transform a valid pipeline sink.
- Reject duplicate, self, unknown, mismatched, cyclic, isolated and
  wrongly directed edges. Graphs must have an authorized ingress root.
- Actor instance identities are compared as **exact UTF-8 sequences**, not
  Unicode-normalized or case-folded strings. For example, composed `é` and
  decomposed `e + U+0301` remain distinct instances. The supervisor must
  avoid visually ambiguous names in administrative interfaces.
- An edge's identity is the **structural tuple** `(source instance ID,
  target instance ID)`, never string concatenation using user-controlled
  delimiters. `(a:b, c)` and `(a, b:c)` are separate valid connections.
- Connection order is the supervisor-published edge order, never hash map
  iteration order or task scheduling order. On topology generation change,
  rebuild selectors only after quiescence or an explicit abort barrier.

## Sealed actor methods and routing policies

| Oreslang intrinsic | Routing requirement |
| --- | --- |
| `self.forward(value)` | exactly one connected downstream; reject ambiguity |
| `self.forward_all(value)` | every downstream in edge order; one per-edge admission result |
| `self.forward_round_robin(value)` | one downstream, strict **source+generation** cursor, each attempted selection consumes a turn |
| `self.forward_to(target, value)` | only a supervisor-authorized outgoing edge |
| `self.forward_by_key(key, value)` | UTF-8 key bytes, 0..4096 bytes, exact FNV-1a **unsigned 64-bit** mod connected edge count |
| `self.backward(value)` | one correlated immediate authenticated upstream hop |
| `self.reply(value)` | correlated reverse path to the original sender, preserving branch identity |

Graph identifiers prohibit embedded NUL. **Routing keys are different**:
they may be empty or contain U+0000, hashed as their exact UTF-8 bytes.
Reject malformed Unicode; do not replace invalid code points or treat the
first NUL as string termination. The canonical `"\\u0000"` vector
hashes to `af63bd4c8601b7df`, which selects `worker-a` in the
three-consumer fixture.

`forward_all` is **not transactional**. A successful receipt is only
mailbox admission, not processing or exactly-once delivery. Partial success
is returned per edge, never hidden. A moved unique value cannot be fanned
out without explicit copying or immutable sharing. Per-edge message/byte/
pending-writer capacity must be bounded.

An actor executes on at most one physical carrier at a time. Sendable
messages must obey per-actor ownership, no mutable cross-isolate aliases,
no borrowed loans across suspension, and lifecycle barriers: STOP seals
new admission; accepted mail and terminal cleanup obey supervisor policy;
DONE follows complete cleanup. No actor carrier may block on a host
retirement gate.

**Keyed route validation order:** validate the active graph generation and
caller-authorized downstream source **before** inspecting or hashing the
user-supplied UTF-8 key. Unknown sources and retired generations must fail
with their routing/retirement diagnostic even if the key is malformed.
The scheduler's actor identity authorization remains a separate, stronger
precondition before any selector operation.

## Fixed cross-backend selector vectors

Three downstream edges, in publication order: `worker-a`, `worker-b`,
`worker-c`. Fan-out returns `[worker-a, worker-b, worker-c]`.
Round-robin returns `a,b,c,a,b,c`; selecting and then failing mailbox
admission still consumes that position. `forward` rejects this graph;
`forward_to(worker-b)` selects `worker-b`;
`forward_to(worker-z)` rejects.

FNV-1a64 modulo 3:
- `customer-7` -> `worker-a` (hash `660308ab83c6fdf1`)
- `alpha` -> `worker-a` (hash `8ac625bb85ed202b`)
- `beta` -> `worker-c` (hash `7627619b954620a7`)
- `🌍` -> `worker-a` (hash `ff430438753bca3b`)
- empty key -> `worker-c` (hash `cbf29ce484222325`)

Reject invalid Unicode, overlong encodings, NUL in graph identity,
duplicate actor instance IDs, source spoofing, unknown destination,
unsupported actor mode and post-retirement routing.

## Evidence labels required in backend PRs

**A: guest-executed parity**: identical typed Oreslang source fixtures
compiled and run with real actor messages and correlated reverse replies.

**B: native/host message parity**: real bounded mailbox routing, with
source authority and lifecycle checks (but no compiled guest `self.*`).

**C: selector parity**: checked graph + routing decisions tested, no guest
message delivery.

**D: fail-closed bootstrap**: unimplemented source constructs are rejected;
an independent selector contract may exist but must not imply actor
execution. Avoid accepting syntax as a placeholder noop.

A CI pass proves only tests **actually executed on an exact, approved tree**.
A zero-step GitHub Actions failure is no test evidence. Never copy private
trees into an unapproved organization, even if it has available minutes.
