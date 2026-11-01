# Oreslang replayable byte stream — oreslang-source.wasm conformance admission

**Status, 2026-11-01: source fixtures staged, NOT validated or enabled.** The current oreslang-source.wasm backend is not certified to compile or execute this userland stream. Do not treat a successful source contract/host mock test as a native guest pass.

Canonical implementation and contract: https://github.com/ores-truffle-oreslang/oreslang-source.java/pull/2445
- `stdlib/replay_stream.ores`
- `examples/native-replay-stream-contract.ores`
- `docs/REPLAYABLE_BYTE_STREAM_V1.md`

This directory contains exact-copy `replay_stream.ores` and the same 64-check Oreslang guest `native-replay-stream-contract.ores` with only its relative module import path changed. They are **conformance targets**, not supported compiled APIs or proof that the parser/runtime accepts them.

## Obligations before enabling

1. Compile the actual guest with oreslang-source.wasm, using the exact candidate Git commit and compiler/source SHA. If constructs are unsupported, reject them with a deterministic diagnostic and no executable artifact. Record `unsupported`, not `passed`.
2. Actually execute the compiled guest (not JavaScript/Python/Rust emulation, host-only assertions or Java/GraalVM fallback). Verify 64 unique `REPLAY-PASS|...` receipts, one `REPLAY-CONTRACT-DONE`, exit 0, and source/compiler hash.
3. Ensure `Array<int>` indexed writes/reads, class member mutability, `Result<T,E>`, import resolution, module constructors and bounded storage respect the same observable semantics. Prevent unbounded allocations/aliasing and silent wraparound.
4. Add runtime transport + actor ownership tests for physical backpressure, authenticated cumulative ACK, stale-incarnation rejection, cancellation and race-safe release. No actor state loan/critical section crosses an await; no blocking codec/socket call on scheduler carriers.
5. For media, add decoder/encoder conformance with real native adapter or permitted host import, bounded frame queue, codec state and keyframe resync, damaged/partial access units, reconnect and replay-window expiry. Failing to support a codec must be typed `UnsupportedCodec`, not a fake decoded frame.
6. Report actual executed CI job step list; `steps=[]`, `steps=null` or runner_id=0 are runner-admission failures and provide no test evidence. Keep the PR draft until stepful exact-head native verification and independent review.

## Semantic invariants

- 2,097,152 is a **logical payload-byte capacity**, not RSS. The current reference stores bytes as `Array<int>`; do not advertise 2 MiB physical memory or zero-copy until byte-addressed native storage and allocator quotas are measured.
- Bytes are indexed by monotonic stream offset. `floor <= acked <= sent <= produced` is NOT always true: `floor` may be below `acked`, and `sent <= produced`. The required invariants are `0 <= floor <= acked <= sent <= produced` for this reference under valid operations, except that `floor` and `acked` can differ. No unACKed byte is overwritten.
- Reconnect uses an authenticated receiver-contiguous committed offset and stream/session incarnation, not TCP write completion. Duplicates are idempotently deduplicated by the receiver.
- Requests before the retained floor fail `ReplayWindowExpired`; requests beyond produced data fail `OffsetNotProduced`; stale actor generations fail `StaleGeneration`; unACKed capacity exhaustion fails `Backpressure`.
- In-memory replay survives network disconnection only while the actor/process remains alive. Actor crash recovery requires durable/replicated video segments and persisted stream metadata.
- `Result.Err` retains the error; `trap` is lossy and should not drive retry decisions. Panic/cancellation remain distinct terminal effects.

**Nothing in this fixture grants a codec, raw socket, FFI handle, network capability, or cross-tenant access.**
