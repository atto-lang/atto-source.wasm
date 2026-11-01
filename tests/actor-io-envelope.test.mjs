import test from "node:test";
import assert from "node:assert/strict";
import {ActorIoEnvelope} from "../src/runtime/actor-io.mjs";

test("actor io channels are bounded, copied and independent", () => {
  const io = new ActorIoEnvelope({actorId: 1, maxRecords: 2, maxBytes: 4});
  const auth = io.authority();
  const source = Uint8Array.from([1, 2]);
  assert.equal(io.tryFeedInput(auth, source), true);
  source[0] = 9;
  assert.deepEqual([...io.readInput(auth)], [1, 2]);

  assert.equal(io.tryWriteOutput(auth, Uint8Array.from([3, 4, 5, 6])), true);
  assert.equal(io.tryWriteOutput(auth, Uint8Array.of(7)), false);
  assert.equal(io.tryEmitEvent(auth, {kind: "r", payload: "x"}), true,
    "output backpressure must not consume event quota");
  assert.deepEqual([...io.readOutput(auth)], [3, 4, 5, 6]);
  assert.deepEqual(io.readEvent(auth), {kind: "r", payload: "x"});
});

test("actor io error/events are typed and metadata is immutable versioned snapshot", () => {
  const io = new ActorIoEnvelope({actorId: 2});
  const auth = io.authority();
  assert.equal(io.tryEmitError(auth, {code: "E_PARSE", message: "bad token"}), true);
  assert.deepEqual(io.readError(auth), {code: "E_PARSE", message: "bad token"});
  const input = {trace_id: "abc", route: "/v1"};
  const snap = io.replaceMetadata(auth, input);
  input.trace_id = "mutated";
  assert.equal(snap.version, 2);
  assert.equal(snap.values.trace_id, "abc");
  assert.throws(() => { snap.values.trace_id = "x"; }, TypeError);
  assert.equal(io.metadata(auth).values.route, "/v1");
});

test("actor io authority rejects stale handles and restart erases retired state", () => {
  const io = new ActorIoEnvelope({actorId: 3});
  const first = io.authority();
  const forged = Object.freeze({actorId: first.actorId, generation: first.generation});
  assert.throws(() => io.tryWriteOutput(forged, Uint8Array.of(1)), /stale, foreign, or retired/);

  assert.equal(io.tryWriteOutput(first, Uint8Array.of(9, 9)), true);
  assert.equal(io.tryEmitEvent(first, {kind: "old", payload: "generation"}), true);
  io.replaceMetadata(first, {trace_id: "old"});

  const second = io.restart(2);
  assert.throws(() => io.metadata(first), /stale, foreign, or retired/);
  assert.equal(io.readOutput(second), undefined, "restart must erase old output");
  assert.equal(io.readEvent(second), undefined, "restart must erase old events");
  assert.equal(io.metadata(second).version, 1, "metadata version resets per generation");
  assert.deepEqual(
    Object.keys(io.metadata(second).values), [],
    "restart must erase old metadata");
  assert.equal(io.tryWriteOutput(second, Uint8Array.of(2)), true);
});

test("128 actors preserve per-actor FIFO and noninterference", () => {
  const actors = Array.from({length: 128}, (_, i) =>
    new ActorIoEnvelope({actorId: i + 100, maxRecords: 8, maxBytes: 64}));
  for (let i = 0; i < actors.length; i++) {
    const io = actors[i];
    const auth = io.authority();
    assert.equal(io.tryWriteOutput(auth, Uint8Array.of(i & 255, 1)), true);
    assert.equal(io.tryWriteOutput(auth, Uint8Array.of(i & 255, 2)), true);
  }
  for (let i = actors.length - 1; i >= 0; i--) {
    const io = actors[i];
    const auth = io.authority();
    assert.deepEqual([...io.readOutput(auth)], [i & 255, 1]);
    assert.deepEqual([...io.readOutput(auth)], [i & 255, 2]);
    assert.equal(io.readOutput(auth), undefined);
  }
});

test("metadata and record quotas fail closed", () => {
  const io = new ActorIoEnvelope({actorId: 4, maxRecords: 1, maxBytes: 2});
  const auth = io.authority();
  assert.equal(io.tryFeedInput(auth, Uint8Array.of(1, 2)), true);
  assert.equal(io.tryFeedInput(auth, Uint8Array.of()), false, "record quota includes empty records");
  assert.equal(
    io.tryWriteOutput(auth, Uint8Array.of(1, 2, 3)),
    false,
    "oversized single record must fail before mutation");
  assert.equal(
    io.readOutput(auth),
    undefined,
    "oversized record must not partially enqueue");
  assert.throws(() => io.replaceMetadata(auth,
    Object.fromEntries(Array.from({length: ActorIoEnvelope.MAX_METADATA_ENTRIES + 1},
      (_, i) => ["k" + i, "v"]))), /entry limit/);
  assert.throws(() => io.replaceMetadata(auth, {
    oversized: "x".repeat(ActorIoEnvelope.MAX_METADATA_BYTES + 1),
  }), /byte limit/);
});
