# Wasm actor arena prototype (host-only)

`src/actor-arena.mjs` provides a fixed two-page WebAssembly.Memory per actor incarnation (including SHARED actors), one persistent and one turn-scratch. Its opaque JS handles enforce actor-domain identity, fresh turn admission and rejection of old scratch handles. Reads return copies, not aliased views. Zeroization and handle revocation are explicit.

**Not guest integration:** the existing `core-wasm.i64-v1` guest cannot instantiate Oreslang actors, receive pointers, access this separately allocated memory, or share memory between workers. No new Wasm import or export is enabled. JS GC determines when the private WebAssembly.Memory itself is physically reclaimed. `SharedArrayBuffer` and cross-worker shared mutable regions remain unsupported. This prototype is an adapter seed for `oreslang-common-source/docs/SHARED_ACTOR_ARENAS_V1.md` and is not source-language arena parity.

Before integrating: replace JS host handles with compiler-generated guest offset/generation tables, explicit arena owner/lease validation, trap-safe scratch teardown on suspension/cancellation, physical instance retirement and source-level conformance. An ActorRef must never be usable as an arena handle.
