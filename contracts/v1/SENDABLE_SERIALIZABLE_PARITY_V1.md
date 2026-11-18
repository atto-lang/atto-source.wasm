# Sendable / Serializable parity contract v1 — five backends

Status: **common target, not implemented feature parity**. This exact contract and JSON fixture must be byte-identical across `.java`, `.llvm`, `.net`, `.wasm`, `.forge`. Matching text does not certify implementations.

**Separation:** `Sendable` is a compiler-derived proof that an owned value safely crosses an actor/supervisor isolation boundary, without writable aliases, live borrows, closures, host handles, or unresolved generics. `Serializable<MessagePack|Json|Protobuf>` additionally requires an explicit format-specific, bounded, schema-checked codec; it does not follow automatically from `Sendable`. Missing proofs and codec registrations reject closed.

**Authority:** `ActorRef` is a scoped local capability, never data sent through an ordinary wire codec; numeric ID/generation and schema hashes grant no authority. A different mailbox with identical public identifiers and a stale reference after restart must fail. Supervisor CONTROL events, channels and locks remain out of untrusted network data. `SharedMutex` and runtime/codec/supervisor capabilities cannot travel through any ordinary actor mailbox, including shared-actor or nested generic messages; they are not wire-serializable. A separately designed supervisor CONTROL channel is required for authenticated lifecycle events.

**Atomicity:** Validate expected receiver type and runtime provenance; reserve quotas; make a safe owned copy/move/encode; publish once. On failure, cancellation, actor death, and restart, release reservations and discard undelivered owned bytes. Sender-owned memory must not be wiped or mutated by mailbox cleanup.

**Wire:** MessagePack v2 existing golden bytes cannot change silently. JSON and Protobuf require independently implemented versioned descriptors, strict decoding and explicit tests. Length, depth, node, UTF-8, integer overflow, canonicality, full consumption, and unknown version/tag are rejection gates. Codec schema hashes are not authentication.

## Implementation evidence, not parity

| Backend | Verified subset | Not established |
|---|---|---|
| Java/GraalVM | Actor boundary compiler JUnit tests, existing actor runtime | Trait syntax/derivation, native-image runtime transport, JSON/Protobuf |
| LLVM | C++ native MessagePack v2 collection/tagged vectors | General actor source lowering, owned local transfer, JSON/Protobuf |
| .NET | Owned bounded byte mailbox and private nonce/generation | Typed Sendable compiler, actor/wire codecs |
| Wasm | Pinned no-import scalar guest/worker admission | Actor/supervisor data transport and typed wire formats |
| Forge | Bounded byte mailbox, private local authority in parity branch | Typed actor source lowering and codecs |

The adjacent `sendable-serializable-parity.v1.json` defines cross-backend intended admission cases. A backend missing a feature must report **unsupported** and must not mark that case as a pass. To claim parity for a feature, attach actual executed compiler/runtime/codec tests from each backend (JDK/Graal, Clang, dotnet, Node/Wasm, CMake), source SHA, mirrored Git-blob manifest and hosted runner URL. Private source mirrors must remain private; no cross-org checkout secrets.
