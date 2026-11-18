# Actor Pub/Sub v1 parity target

Wasm/Wasmtime: topic registries must remain isolate-local by default and tenant-scoped. Cross-isolate publication requires an explicit transport. Unsupported source-level ActorGroup/Topic constructs must fail closed until lowering and runtime support are present.

Normative contract: `contracts/v1/actor-pubsub-v1.json`.

No `define publisher` or `define subscriber` language forms are introduced. The shared source model is `ActorGroup`, `Topic<T>`, `Subscription<T>`, and `PublishReceipt`; actors may belong to multiple groups simultaneously, and group membership is never lifecycle ownership.

Golden source parity fixture: `contracts/v1/fixtures/actor-pubsub-v1.ores`.
The backend must either execute this fixture with the normative output or reject the unsupported source surface before lowering; host-only scaffolding is not parity evidence.


## Host in-memory hardening limits

The JavaScript `WasmActorPubSub` substrate remains host-only; caller-controlled
`registerActor` must never be exported to untrusted guest code. A numeric
`actorId` and `incarnation` are **not** proof of runtime admission. The
trusted host must retire the matching pub/sub actor on physical actor teardown;
source lowering and cross-backend conformance remain separate work.

The registry enforces hard ceilings independent of optional instance quotas:
4,096 live actors, 65,536 lifetime actor-ID histories, 4,096 groups, 4,096
members per group, 4,096 memberships per actor, 4,096 topics, 1,024 subscriptions
per actor, and 1,024 queued entries per subscription. The shared pending-event
budget defaults to 16,384 queued slots (hard ceiling 65,536). Configured limits
may only decrease these ceilings. When the shared budget is full, RELIABLE
publication declines atomically for **all** subscribers; LOSSY drops newly
offered events; LATEST may coalesce an occupied slot but must not add a new one.
Read, unsubscribe, group leave, group close, actor retirement and shutdown
release accounted slots. A string payload is limited to 4,096 UTF-16 code
units; malformed/unpaired UTF-16 surrogates are rejected in both topic names
and string payloads to prevent lossy cross-runtime Unicode conversion.
Numbers must be finite and bigint payloads must fit signed i64.

These guards bound the number of retained event slots, not OS process RSS or
the scheduler's CPU consumption. They do not provide authenticated multi-tenant
remote messaging, durable broker semantics, handler acknowledgements,
asynchronous RELIABLE waiters, or compiler-verified source `Topic<T>` parity.
