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
