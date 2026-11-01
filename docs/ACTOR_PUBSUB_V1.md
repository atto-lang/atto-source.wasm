# Actor Pub/Sub v1 parity target

Wasm/Wasmtime: topic registries must remain isolate-local by default and tenant-scoped. Cross-isolate publication requires an explicit transport. Unsupported source-level ActorGroup/Topic constructs must fail closed until lowering and runtime support are present.

Normative contract: `contracts/v1/actor-pubsub-v1.json`.

No `define publisher` or `define subscriber` language forms are introduced. The shared source model is `ActorGroup<T>`, `Topic<T>`, `Subscription<T>`, and `PublishReceipt`; actors may belong to multiple groups simultaneously, and group membership is never lifecycle ownership.
