import test from "node:test";
import assert from "node:assert/strict";
import {ActorIoEnvelope} from "../src/runtime/actor-io.mjs";

test("input half-close retains FIFO and publishes EOF only after drain", () => {
  const io = new ActorIoEnvelope({actorId: 6201, maxRecords: 3, maxBytes: 3});
  const auth = io.authority();
  assert.equal(io.inputAtEof(auth), false);
  assert.equal(io.tryFeedInput(auth, Uint8Array.of(1, 2)), true);
  assert.equal(io.tryFeedInput(auth, Uint8Array.of(3)), true);
  assert.equal(io.closeInput(auth), true);
  assert.equal(io.closeInput(auth), false, "duplicate close is idempotent");
  assert.equal(io.inputAtEof(auth), false, "queued data precedes EOF");
  assert.equal(io.tryFeedInput(auth, Uint8Array.of(4)), false);
  assert.equal(io.tryFeedInput(auth, Uint8Array.of()), false,
    "empty writes must not reopen a closed stream");
  assert.deepEqual([...io.readInput(auth)], [1, 2]);
  assert.equal(io.inputAtEof(auth), false);
  assert.deepEqual([...io.readInput(auth)], [3]);
  assert.equal(io.inputAtEof(auth), true);
  assert.equal(io.readInput(auth), undefined);
});

test("output half-close preserves buffered output and independent input", () => {
  const io = new ActorIoEnvelope({actorId: 6202});
  const auth = io.authority();
  assert.equal(io.tryWriteOutput(auth, Uint8Array.of(5, 6)), true);
  assert.equal(io.closeOutput(auth), true);
  assert.equal(io.closeOutput(auth), false);
  assert.equal(io.outputAtEof(auth), false);
  assert.equal(io.tryWriteOutput(auth, Uint8Array.of(7)), false);
  assert.equal(io.tryWriteOutput(auth, Uint8Array.of()), false);
  assert.deepEqual([...io.readOutput(auth)], [5, 6]);
  assert.equal(io.outputAtEof(auth), true);
  assert.equal(io.tryFeedInput(auth, Uint8Array.of(9)), true,
    "closing output must not close input");
  assert.deepEqual([...io.readInput(auth)], [9]);
});

test("input half-close does not prevent output, errors or events", () => {
  const io = new ActorIoEnvelope({actorId: 6203});
  const auth = io.authority();
  assert.equal(io.closeInput(auth), true);
  assert.equal(io.inputAtEof(auth), true);
  assert.equal(io.tryWriteOutput(auth, Uint8Array.of(1)), true);
  assert.equal(io.tryEmitError(auth, {code:"E", message:"bad"}), true);
  assert.equal(io.tryEmitEvent(auth, {kind:"end", payload:"input"}), true);
  assert.deepEqual([...io.readOutput(auth)], [1]);
  assert.equal(io.readError(auth).message, "bad");
  assert.equal(io.readEvent(auth).kind, "end");
});

test("restart revokes former authority and resets EOF state", () => {
  const io = new ActorIoEnvelope({actorId: 6204});
  const old = io.authority();
  assert.equal(io.tryFeedInput(old, Uint8Array.of(8)), true);
  assert.equal(io.closeInput(old), true);
  assert.equal(io.closeOutput(old), true);
  const fresh = io.restart(2);
  for (const check of [
    () => io.inputAtEof(old), () => io.outputAtEof(old),
    () => io.closeInput(old), () => io.closeOutput(old)
  ]) assert.throws(check, /stale, foreign, or retired/);
  assert.equal(io.inputAtEof(fresh), false);
  assert.equal(io.outputAtEof(fresh), false);
  assert.equal(io.readInput(fresh), undefined, "stale queued bytes discarded");
  assert.equal(io.tryFeedInput(fresh, Uint8Array.of(9)), true);
  assert.equal(io.tryWriteOutput(fresh, Uint8Array.of(10)), true);
  assert.deepEqual([...io.readInput(fresh)], [9]);
  assert.deepEqual([...io.readOutput(fresh)], [10]);
});

test("foreign authority cannot close another actor's channel", () => {
  const first = new ActorIoEnvelope({actorId: 6205});
  const second = new ActorIoEnvelope({actorId: 6206});
  const foreign = second.authority();
  assert.throws(() => first.closeInput(foreign), /stale, foreign, or retired/);
  assert.throws(() => first.closeOutput(foreign), /stale, foreign, or retired/);
  assert.equal(first.tryFeedInput(first.authority(), Uint8Array.of(1)), true);
});
