import test from "node:test";
import assert from "node:assert/strict";
import {ActorArena} from "../src/actor-arena.mjs";

test("shared actors get private arenas, not transferable heap handles", () => {
  const a = new ActorArena({actorId: 1, incarnation: 1, kind: "shared"});
  const b = new ActorArena({actorId: 2, incarnation: 1, kind: "shared"});
  const ta = a.beginTurn();
  const tb = b.beginTurn();
  const h = a.allocPersistent(ta, 4);
  a.write(ta, h, Uint8Array.from([1, 2, 3, 4]));
  assert.deepEqual([...a.read(ta, h)], [1, 2, 3, 4]);
  assert.throws(() => b.read(tb, h), /foreign or stale/);
  assert.throws(() => a.read(tb, h), /turn authority/);
  const copy = a.read(ta, h);
  copy[0] = 99;
  assert.equal(a.read(ta, h)[0], 1);
  a.endTurn(ta);
  b.endTurn(tb);
  const next = a.beginTurn();
  assert.equal(a.read(next, h)[0], 1);
  a.endTurn(next);
  a.retire();
  b.retire();
  assert.throws(() => a.beginTurn(), /retired/);
});

test("scratch invalidates and zeroes at each mailbox turn", () => {
  const arena = new ActorArena({actorId: 3, incarnation: 4});
  const turn = arena.beginTurn();
  const old = arena.allocScratch(turn, 8);
  arena.write(turn, old, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
  assert.throws(() => arena.beginTurn(), /already admitted/);
  assert.throws(() => arena.retire(), /active actor turn/);
  arena.endTurn(turn);
  const next = arena.beginTurn();
  assert.throws(() => arena.read(next, old), /foreign or stale/);
  const scratch = arena.allocScratch(next, 8);
  assert.deepEqual([...arena.read(next, scratch)], Array(8).fill(0));
  arena.endTurn(next);
  arena.retire();
  arena.retire();
});

test("bounded allocations and foreign incarnation reject closed handles", () => {
  for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new ActorArena({actorId: bad, incarnation: 1}), /invalid actor/);
  }
  const a = new ActorArena({actorId: 1, incarnation: 1});
  const t = a.beginTurn();
  assert.throws(() => a.allocPersistent(t, 0), /invalid arena/);
  assert.throws(() => a.allocPersistent(t, 65537), /invalid arena/);
  const h = a.allocPersistent(t, 65536);
  assert.throws(() => a.allocPersistent(t, 1), /quota exhausted/);
  assert.throws(() => a.write(t, h, new Uint8Array(1)), /exact-size/);
  a.endTurn(t);
  a.retire();
  const restarted = new ActorArena({actorId: 1, incarnation: 2});
  const tr = restarted.beginTurn();
  assert.throws(() => restarted.read(tr, h), /foreign or stale/);
  restarted.endTurn(tr);
  restarted.retire();
});

test('persistent drop reclaims memory without reviving stale handles', () => {
  const arena = new ActorArena({actorId: 31, incarnation: 1});
  const turn = arena.beginTurn();
  const first = arena.allocPersistent(turn, 65536);
  arena.write(turn, first, new Uint8Array(65536).fill(77));
  assert.throws(() => arena.allocPersistent(turn, 1), /quota exhausted/);
  arena.dropPersistent(turn, first);
  assert.throws(() => arena.read(turn, first), /foreign or stale/);
  assert.throws(() => arena.dropPersistent(turn, first), /foreign, stale/);
  const replacement = arena.allocPersistent(turn, 65536);
  assert.deepEqual([...arena.read(turn, replacement)].slice(0, 16), Array(16).fill(0));
  assert.throws(() => arena.dropPersistent(turn, arena.allocScratch(turn, 8)), /scratch arena handle/);
  arena.endTurn(turn);
  const next = arena.beginTurn();
  assert.equal(arena.read(next, replacement).length, 65536);
  arena.endTurn(next);
  arena.retire();
});

test("shared worker backing is rejected before it can tear an actor write", () => {
  const arena = new ActorArena({actorId: 34, incarnation: 1});
  const turn = arena.beginTurn();
  const handle = arena.allocPersistent(turn, 4);
  if (typeof SharedArrayBuffer !== "undefined") {
    const shared = new Uint8Array(new SharedArrayBuffer(4));
    shared.set([4, 3, 2, 1]);
    assert.throws(() => arena.write(turn, handle, shared), /shared backing/);
    assert.deepEqual([...arena.read(turn, handle)], [0, 0, 0, 0],
      "denied write must leave target bytes intact");
  }
  arena.write(turn, handle, Uint8Array.from([1, 2, 3, 4]));
  assert.deepEqual([...arena.read(turn, handle)], [1, 2, 3, 4]);
  arena.endTurn(turn);
  arena.retire();
});

test('many allocation/drop cycles reuse space and reject stale handles', () => {
  const arena = new ActorArena({actorId: 32, incarnation: 1});
  const turn = arena.beginTurn();
  let old;
  for (let i = 0; i < 12000; i++) {
    const handle = arena.allocPersistent(turn, (i % 31) + 1);
    const data = new Uint8Array((i % 31) + 1).fill(i % 251);
    arena.write(turn, handle, data);
    assert.deepEqual([...arena.read(turn, handle)], [...data]);
    if (old) assert.throws(() => arena.read(turn, old), /foreign or stale/);
    arena.dropPersistent(turn, handle);
    old = handle;
  }
  arena.endTurn(turn);
  arena.retire();
});

test('persistent and scratch handles have bounded metadata quotas', () => {
  const arena = new ActorArena({actorId: 33, incarnation: 1});
  const turn = arena.beginTurn();
  const handles = Array.from({length: 4096}, () => arena.allocPersistent(turn, 1));
  assert.throws(() => arena.allocPersistent(turn, 1), /handle quota exhausted/);
  arena.dropPersistent(turn, handles[0]);
  assert.equal(arena.read(turn, arena.allocPersistent(turn, 1))[0], 0);
  const scratch = Array.from({length: 4096}, () => arena.allocScratch(turn, 1));
  assert.throws(() => arena.allocScratch(turn, 1), /handle quota exhausted/);
  arena.endTurn(turn);
  const next = arena.beginTurn();
  assert.throws(() => arena.read(next, scratch[0]), /foreign or stale/);
  arena.endTurn(next);
  arena.retire();
});

test("actor arena write validates native typed-array slots across realms", async () => {
  const {default: vm} = await import("node:vm");
  const arena = new ActorArena({actorId: 35, incarnation: 1});
  const turn = arena.beginTurn();
  const handle = arena.allocPersistent(turn, 4);
  arena.write(turn, handle, new Uint8Array([9, 8, 7, 6]));

  const short = new Uint8Array([1, 2]);
  Object.defineProperty(short, "byteLength", {value: 4});
  assert.throws(() => arena.write(turn, handle, short), /exact-size/);
  assert.deepEqual([...arena.read(turn, handle)], [9, 8, 7, 6]);

  const privateBytes = new Uint8Array([4, 3, 2, 1]);
  for (const key of ["byteLength", "buffer"]) {
    Object.defineProperty(privateBytes, key, {
      get() {throw Error("unexpected property access: " + key);}
    });
  }
  assert.doesNotThrow(() => arena.write(turn, handle, privateBytes));
  assert.deepEqual([...arena.read(turn, handle)], [4, 3, 2, 1]);

  if (typeof SharedArrayBuffer === "function") {
    const shared = new Uint8Array(new SharedArrayBuffer(4));
    shared.set([7, 7, 7, 7]);
    Object.defineProperty(shared, "buffer", {value: new ArrayBuffer(4)});
    Object.defineProperty(shared, "byteLength", {value: 4});
    assert.throws(() => arena.write(turn, handle, shared), /shared backing/);
    const foreignShared = vm.runInNewContext("new Uint8Array(new SharedArrayBuffer(4))");
    assert.throws(() => arena.write(turn, handle, foreignShared), /shared backing/);
    assert.deepEqual([...arena.read(turn, handle)], [4, 3, 2, 1]);
  }
  const foreignPrivate = vm.runInNewContext("new Uint8Array([1, 2, 3, 4])");
  assert.doesNotThrow(() => arena.write(turn, handle, foreignPrivate));
  assert.deepEqual([...arena.read(turn, handle)], [1, 2, 3, 4]);
  arena.endTurn(turn);
  arena.retire();
});


test('arena writes fail closed for detached or forged typed-array views', () => {
  const arena = new ActorArena({actorId: 36, incarnation: 1});
  const turn = arena.beginTurn();
  const handle = arena.allocPersistent(turn, 4);
  arena.write(turn, handle, Uint8Array.from([8, 7, 6, 5]));

  // A typed-array prototype alone does not confer native internal slots.
  const forged = Object.create(Uint8Array.prototype);
  Object.defineProperty(forged, 'byteLength', {value: 4});
  Object.defineProperty(forged, 'buffer', {value: new ArrayBuffer(4)});
  assert.throws(() => arena.write(turn, handle, forged), /exact-size/);
  assert.throws(() => arena.write(turn, handle, new Uint16Array(2)), /exact-size/);

  // A previously admissible byte view must become inadmissible after detach.
  const detachedBacking = new ArrayBuffer(4);
  const detached = new Uint8Array(detachedBacking);
  detached.set([1, 2, 3, 4]);
  structuredClone(detachedBacking, {transfer: [detachedBacking]});
  assert.equal(detached.byteLength, 0);
  assert.throws(() => arena.write(turn, handle, detached), /exact-size/);
  assert.deepEqual([...arena.read(turn, handle)], [8, 7, 6, 5],
    'failed admissions must never partially change actor-owned data');

  // The caller may supply a precise view into a larger, private buffer.
  // Copy only the view, not its surrounding backing allocation.
  const padded = Uint8Array.from([99, 1, 2, 3, 4, 88]);
  arena.write(turn, handle, padded.subarray(1, 5));
  assert.deepEqual([...arena.read(turn, handle)], [1, 2, 3, 4]);

  arena.endTurn(turn);
  arena.retire();
});
