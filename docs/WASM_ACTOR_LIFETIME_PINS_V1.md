# Wasm actor arena: external lifetime-pin admission (host-only)

Status: prototype, not source-language allocation lowering or a zero-host-GC claim.

The host `ActorArena` keeps a private bounded `WebAssembly.Memory`.
A physical actor turn owns all guest byte access. An async continuation, I/O
callback, timer, or FFI adapter may outlive a turn and must register a
**lifetime-only** pin *before* publishing its external operation:

1. While holding its active `turn`, call `pinLifetime(turn)`.
2. End the turn. The pin permits no `read`, `write`, `allocPersistent`,
   `dropPersistent` or `beginTurn` by itself.
3. On STOP, `retire()` immediately revokes new actor authority. Already
   issued pins keep the private memory reachable until corresponding external
   owners acknowledge completion, cancellation, or callback termination.
4. Call `releaseLifetimePin(pin)` on every terminal path (including errors).
   Release is idempotent for an issued pin; stale/foreign/forged pins are
   rejected. The last release scrubs all guest bytes and drops the host memory
   reference. `retire()` can retry a failed scrub without reopening the arena.

There are at most 4,096 outstanding lifetime pins; budget failure is
nonmutating. Restart creates a new `ActorArena` with a new incarnation,
whose capability set cannot recognize old tokens. A late callback may
release its old pin but may not access a retired actor's memory.

**Important**: the patch provides a host API and its direct regressions.
Existing worker/continuation/FFI adapters have **not** been proved to call
`pinLifetime` and `releaseLifetimePin` on all paths; this is a separate
integration requirement. The underlying `WebAssembly.Memory` is owned by a
JavaScript process, so dropping a reference and zeroing bytes does not force
the JS runtime to physically free its pages at a deterministic instant.

For zero **guest tracing GC**, separately require compiled source values to
lower to linear-memory offsets and deterministic drop/arena operations,
with a sealed import set and no Wasm-GC reference types/opcodes. For zero
**host GC**, this Node/V8 adapter makes no such promise. Host-allocated
WeakMaps, opaque handles, and returned byte copies remain managed objects.

## Regression requirements

The `tests/actor-arena.test.mjs` suite adds:
- STOP during outstanding external lease: immediate logical retirement,
  no fresh guest access, delayed final backing-release;
- concurrent-actor and new-incarnation token rejection;
- forged-token rejection and idempotent duplicate callback completion;
- bounded 4,096-pin capacity, overflow neutrality and reverse-order drain.

**Release gate:** run the exact-branch Node test suite and compiled guest
conformance; do not treat zero-step GitHub Actions runs or source-only tests
as zero-GC or backend parity certification.
