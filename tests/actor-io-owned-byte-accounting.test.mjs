import test from "node:test";
import assert from "node:assert/strict";
import {runInNewContext} from "node:vm";
import {ActorIoEnvelope} from "../src/runtime/actor-io.mjs";

class HostileBytes extends Uint8Array {
  // A normal property lookup reports zero even when two bytes exist.
  get byteLength() { return 0; }
  // Uint8Array.from() calls this, so the old queue retained more than it
  // charged and allowed an actor to evade its byte budget.
  *[Symbol.iterator]() { throw Error("attacker iterator executed"); }
}

test("actor I/O counts actual owned bytes, not overridden byteLength/iterator", () => {
  const io = new ActorIoEnvelope({actorId: 6101, maxRecords: 3, maxBytes: 2});
  const auth = io.authority();
  const hostile = new HostileBytes([1, 2]);
  assert.equal(hostile.byteLength, 0);
  assert.equal(io.tryFeedInput(auth, hostile), true);
  hostile[0] = 99;
  assert.equal(io.tryFeedInput(auth, Uint8Array.of(3)), false,
    "two copied bytes must consume the full channel budget");
  assert.deepEqual([...io.readInput(auth)], [1, 2],
    "copy must ignore Symbol.iterator and producer mutations");
  assert.equal(io.tryFeedInput(auth, Uint8Array.of(4)), true);
  assert.deepEqual([...io.readInput(auth)], [4]);
});

test("actor I/O rejects proxy and counterfeit views without accessing traps", () => {
  const io = new ActorIoEnvelope({actorId: 6102, maxBytes: 8});
  const auth = io.authority();
  let traps = 0;
  const proxy = new Proxy(Uint8Array.of(1, 2), {
    get() { traps++; throw Error("unexpected proxy getter"); },
  });
  assert.throws(() => io.tryWriteOutput(auth, proxy), /genuine Uint8Array/);
  assert.equal(traps, 0);
  assert.throws(
    () => io.tryWriteOutput(auth, Object.create(Uint8Array.prototype)),
    /genuine Uint8Array/);
  assert.equal(io.readOutput(auth), undefined);
});

test("actor I/O byte snapshots reject shared backing stores", () => {
  const io = new ActorIoEnvelope({actorId: 6103, maxBytes: 8});
  const auth = io.authority();
  const shared = new Uint8Array(new SharedArrayBuffer(8));
  assert.throws(() => io.tryFeedInput(auth, shared), /SharedArrayBuffer/);
  assert.equal(io.readInput(auth), undefined);
});

test("actor I/O snapshots exact Buffer slice; accepts bona fide cross-realm views", () => {
  const io = new ActorIoEnvelope({actorId: 6104, maxRecords: 3, maxBytes: 4});
  const auth = io.authority();
  const backing = Buffer.from([9, 1, 2, 9]);
  const slice = backing.subarray(1, 3);
  assert.equal(io.tryWriteOutput(auth, slice), true);
  backing[1] = 99;
  assert.deepEqual([...io.readOutput(auth)], [1, 2]);

  const crossRealm = runInNewContext("new Uint8Array([5, 6])");
  assert.equal(io.tryWriteOutput(auth, crossRealm), true);
  assert.deepEqual([...io.readOutput(auth)], [5, 6]);
});

test("oversized genuine byte views remain backpressured before copy", () => {
  const io = new ActorIoEnvelope({actorId: 6105, maxBytes: 2});
  const auth = io.authority();
  assert.equal(io.tryFeedInput(auth, Uint8Array.of(1, 2, 3)), false);
  assert.equal(io.readInput(auth), undefined);
});


test("detached buffer input fails closed without burning record or byte credit", () => {
  const io = new ActorIoEnvelope({actorId: 6106, maxRecords: 1, maxBytes: 2});
  const auth = io.authority();
  const detached = Uint8Array.of(4, 5);
  structuredClone(detached.buffer, {transfer: [detached.buffer]});
  assert.throws(() => io.tryWriteOutput(auth, detached), /detached|Construct/);
  assert.equal(io.readOutput(auth), undefined);
  assert.equal(io.tryWriteOutput(auth, Uint8Array.of(6, 7)), true);
  assert.deepEqual([...io.readOutput(auth)], [6, 7]);
});

test("resizable backing and out-of-bounds views are refused before ownership handoff", () => {
  const io = new ActorIoEnvelope({actorId: 6107, maxRecords: 1, maxBytes: 8});
  const auth = io.authority();
  const backing = new ArrayBuffer(8, {maxByteLength: 16});
  const live = new Uint8Array(backing);
  assert.equal(backing.resizable, true, "test requires resizable ArrayBuffer support");
  assert.throws(() => io.tryFeedInput(auth, live), /resizable/);
  const fixed = new Uint8Array(backing, 4, 4);
  backing.resize(2); // fixed view is out of bounds and reports zero length.
  assert.equal(fixed.byteLength, 0);
  assert.throws(() => io.tryFeedInput(auth, fixed), /resizable/);
  assert.equal(io.readInput(auth), undefined);
  assert.equal(io.tryFeedInput(auth, Uint8Array.of(9)), true,
    "failure must not consume a record or byte credit");
});

test("byte and record quota are refunded precisely after shifting a snapshot", () => {
  const io = new ActorIoEnvelope({actorId: 6108, maxRecords: 2, maxBytes: 3});
  const auth = io.authority();
  assert.equal(io.tryFeedInput(auth, Uint8Array.of(1, 2)), true);
  assert.equal(io.tryFeedInput(auth, Uint8Array.of(3)), true);
  assert.equal(io.tryFeedInput(auth, Uint8Array.of()), false, "record quota includes empty records");
  assert.deepEqual([...io.readInput(auth)], [1, 2]);
  assert.equal(io.tryFeedInput(auth, Uint8Array.of(4, 5)), true);
  assert.equal(io.tryFeedInput(auth, Uint8Array.of()), false);
  assert.deepEqual([...io.readInput(auth)], [3]);
  assert.deepEqual([...io.readInput(auth)], [4, 5]);
  assert.equal(io.tryFeedInput(auth, Uint8Array.of(6, 7, 8)), true);
  assert.equal(io.tryFeedInput(auth, Uint8Array.of(9)), false, "full byte quota must be enforced");
  assert.deepEqual([...io.readInput(auth)], [6, 7, 8]);
});

test("restart retires buffered bytes, restores quota, and rejects old authority", () => {
  const io = new ActorIoEnvelope({actorId: 6109, maxRecords: 1, maxBytes: 2});
  const old = io.authority();
  const source = Uint8Array.of(7, 8);
  assert.equal(io.tryFeedInput(old, source), true);
  assert.equal(io.tryFeedInput(old, Uint8Array.of()), false);
  const newAuth = io.restart(2);
  source[0] = 99;
  assert.throws(() => io.readInput(old), /stale, foreign, or retired/);
  assert.equal(io.readInput(newAuth), undefined);
  assert.equal(io.tryFeedInput(newAuth, Uint8Array.of(1, 2)), true);
  assert.equal(io.tryFeedInput(newAuth, Uint8Array.of()), false);
  assert.deepEqual([...io.readInput(newAuth)], [1, 2]);
});

test("empty DATA counts as a record even when byte credit is free", () => {
  const io = new ActorIoEnvelope({actorId: 6110, maxRecords: 1, maxBytes: 2});
  const auth = io.authority();
  assert.equal(io.tryWriteOutput(auth, Uint8Array.of()), true);
  assert.equal(io.tryWriteOutput(auth, Uint8Array.of()), false);
  assert.deepEqual([...io.readOutput(auth)], []);
  assert.equal(io.tryWriteOutput(auth, Uint8Array.of(42)), true);
});


test("admission constructor cannot bypass fixed per-channel host ceilings", () => {
  for (const limit of [0, -1, 0.5, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => new ActorIoEnvelope({actorId: 6111, maxRecords: limit}), /maxRecords/);
    assert.throws(() => new ActorIoEnvelope({actorId: 6111, maxBytes: limit}), /maxBytes/);
  }
  assert.throws(() => new ActorIoEnvelope({actorId: 6111, maxRecords: ActorIoEnvelope.MAX_RECORDS + 1}), /maxRecords/);
  assert.throws(() => new ActorIoEnvelope({actorId: 6111, maxBytes: ActorIoEnvelope.MAX_BYTES + 1}), /maxBytes/);
});

test("retiring pending input never mutates previously delivered caller-owned bytes", () => {
  const io = new ActorIoEnvelope({actorId: 6112});
  const old = io.authority();
  assert.equal(io.tryFeedInput(old, Uint8Array.of(1, 2)), true);
  const delivered = io.readInput(old);
  assert.equal(io.tryFeedInput(old, Uint8Array.of(3, 4)), true);
  io.restart(2);
  assert.deepEqual([...delivered], [1, 2], "delivered bytes must remain under caller ownership");
});
