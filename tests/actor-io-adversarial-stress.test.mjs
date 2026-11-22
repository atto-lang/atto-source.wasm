import test from "node:test";
import assert from "node:assert/strict";
import {ActorIoEnvelope} from "../src/runtime/actor-io.mjs";

// Repro before the fix: ActorIoEnvelope.MAX_BYTES = 16 * 1024 * 1024
// allowed constructing a 16 MiB channel even though the advertised fixed
// ceiling was 4 MiB. The class constants and the admission path must agree.
test("public static ceilings cannot be widened or forged by host writes", () => {
  assert.equal(ActorIoEnvelope.MAX_RECORDS, 1024);
  assert.equal(ActorIoEnvelope.MAX_BYTES, 4 * 1024 * 1024);
  assert.equal(ActorIoEnvelope.MAX_METADATA_ENTRIES, 64);
  assert.equal(ActorIoEnvelope.MAX_METADATA_BYTES, 8 * 1024);
  for (const key of ["MAX_RECORDS", "MAX_BYTES", "MAX_METADATA_ENTRIES", "MAX_METADATA_BYTES"]) {
    assert.throws(() => { ActorIoEnvelope[key] = Number.MAX_SAFE_INTEGER; }, TypeError);
    assert.throws(() => Object.defineProperty(ActorIoEnvelope, key, {value: Number.MAX_SAFE_INTEGER}), TypeError);
  }
  assert.throws(() => new ActorIoEnvelope({actorId: 7301, maxBytes: 16 * 1024 * 1024}), /maxBytes/);
  assert.throws(() => new ActorIoEnvelope({actorId: 7301, maxRecords: 1025}), /maxRecords/);
  const io = new ActorIoEnvelope({actorId: 7301});
  const auth = io.authority();
  assert.throws(() => io.replaceMetadata(auth, {
    extra: "a".repeat(ActorIoEnvelope.MAX_METADATA_BYTES + 1),
  }), /byte limit/);
  assert.throws(() => io.replaceMetadata(auth, Object.fromEntries(
    Array.from({length: ActorIoEnvelope.MAX_METADATA_ENTRIES + 1}, (_, i) => [`k${i}`, "v"])
  )), /entry limit/);
});

class PoisonedBytes extends Uint8Array {
  get byteLength() { return 0; }
  *[Symbol.iterator]() { throw new Error("untrusted iteration must never execute"); }
}

// Deterministic model-based randomized admission across separate actors,
// channels and generations. Independent queue and byte-credit model ensures
// errors cannot accumulate as phantom capacity or reordered frames.
test("seeded bounded actor queues preserve FIFO, byte credits and restart fencing", () => {
  let seed = 0x7a77b0b1;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const actors = Array.from({length: 24}, (_, i) => {
    const maxRecords = 1 + (next() % 6);
    const maxBytes = 1 + (next() % 18);
    const io = new ActorIoEnvelope({actorId: i + 7400, maxRecords, maxBytes});
    return {io, auth: io.authority(), generation: 1, maxRecords, maxBytes,
      input: [], output: []};
  });
  const queueFn = [
    ["input", "tryFeedInput", "readInput"],
    ["output", "tryWriteOutput", "readOutput"],
  ];
  for (let step = 0; step < 36000; step++) {
    const state = actors[next() % actors.length];
    const [channel, put, read] = queueFn[next() & 1];
    const queue = state[channel];
    const action = next() % 20;
    if (action === 0) {
      const old = state.auth;
      state.generation++;
      state.auth = state.io.restart(state.generation);
      state.input.length = 0;
      state.output.length = 0;
      assert.throws(() => state.io[put](old, Uint8Array.of(42)), /stale/);
      assert.throws(() => state.io[read](old), /stale/);
    } else if (action < 6) {
      const expected = queue.shift();
      const actual = state.io[read](state.auth);
      if (expected === undefined) assert.equal(actual, undefined);
      else assert.deepEqual([...actual], expected);
    } else {
      const count = next() % 10;
      const contents = Array.from({length: count}, () => next() & 255);
      const source = action % 3 === 0 ? new PoisonedBytes(contents) : Uint8Array.from(contents);
      const usedBytes = queue.reduce((sum, item) => sum + item.length, 0);
      const allowed = queue.length < state.maxRecords && usedBytes + count <= state.maxBytes;
      assert.equal(state.io[put](state.auth, source), allowed,
        `step ${step}, actor ${state.io.authority().actorId}, channel ${channel}`);
      if (allowed) queue.push(contents);
      source.fill(0xa5); // Caller mutation after admission never changes a queued snapshot.
    }
  }
  for (const state of actors) {
    for (const [channel, , read] of queueFn) {
      while (state[channel].length) assert.deepEqual([...state.io[read](state.auth)], state[channel].shift());
      assert.equal(state.io[read](state.auth), undefined);
    }
  }
});

// These are asynchronous event-loop interleavings, not cross-thread shared
// memory concurrency. JS envelopes are actor-local and not transferable to
// other workers: the test asserts admission remains bounded across producers.
test("interleaved asynchronous producers cannot exceed shared actor record quota", async () => {
  const io = new ActorIoEnvelope({actorId: 7501, maxRecords: 7, maxBytes: 32});
  const auth = io.authority();
  let accepted = 0;
  let refused = 0;
  const writers = Array.from({length: 32}, (_, id) => (async () => {
    for (let i = 0; i < 60; i++) {
      await Promise.resolve();
      if (io.tryFeedInput(auth, Uint8Array.of(id, i))) accepted++;
      else refused++;
    }
  })());
  await Promise.all(writers);
  assert.equal(accepted, 7);
  assert.equal(refused, 32 * 60 - 7);
  for (let i = 0; i < 7; i++) assert.equal(io.readInput(auth).byteLength, 2);
  assert.equal(io.readInput(auth), undefined);
  assert.equal(io.tryFeedInput(auth, Uint8Array.of(9, 9)), true,
    "reading must return the record and byte credit");
});

test("deferred producers holding a retired generation cannot resurrect input", async () => {
  const io = new ActorIoEnvelope({actorId: 7502, maxRecords: 3, maxBytes: 3});
  const old = io.authority();
  assert.equal(io.tryFeedInput(old, Uint8Array.of(1, 2)), true);
  const attempts = Array.from({length: 64}, (_, i) => Promise.resolve().then(() => {
    assert.throws(() => io.tryFeedInput(old, Uint8Array.of(i)), /stale/);
    assert.throws(() => io.readInput(old), /stale/);
  }));
  const fresh = io.restart(2);
  await Promise.all(attempts);
  assert.equal(io.readInput(fresh), undefined);
  assert.equal(io.tryFeedInput(fresh, Uint8Array.of(4, 5, 6)), true);
  assert.equal(io.tryFeedInput(fresh, Uint8Array.of(7)), false);
  assert.deepEqual([...io.readInput(fresh)], [4, 5, 6]);
});


test("actor I/O DATA queue ignores poisoned Array.prototype push/shift", () => {
  const io = new ActorIoEnvelope({actorId: 98761, maxRecords: 3, maxBytes: 4});
  const authority = io.authority();
  const oldPush = Array.prototype.push, oldShift = Array.prototype.shift;
  let inputAdmitted, outputAdmitted, input, output;
  try {
    Array.prototype.push = function () { return this.length; };
    Array.prototype.shift = function () { return undefined; };
    inputAdmitted = io.tryFeedInput(authority, Uint8Array.of(17, 29));
    outputAdmitted = io.tryWriteOutput(authority, Uint8Array.of(31, 47));
    input = io.readInput(authority);
    output = io.readOutput(authority);
  } finally {
    Array.prototype.push = oldPush;
    Array.prototype.shift = oldShift;
  }
  assert.equal(inputAdmitted, true);
  assert.equal(outputAdmitted, true);
  assert.deepEqual(Array.from(input), [17, 29]);
  assert.deepEqual(Array.from(output), [31, 47]);
  assert.equal(io.closeInput(authority), true);
  assert.equal(io.inputAtEof(authority), true);
  assert.equal(io.closeOutput(authority), true);
  assert.equal(io.outputAtEof(authority), true);
});
