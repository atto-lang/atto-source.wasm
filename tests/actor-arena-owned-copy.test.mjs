import test from "node:test";
import assert from "node:assert/strict";
import {ActorArena} from "../src/actor-arena.mjs";

test("owned arena reads preserve copies, bounds and turn lifetimes", () => {
  const a = new ActorArena({actorId: 1, incarnation: 1});
  const b = new ActorArena({actorId: 2, incarnation: 1});
  const turn = a.beginTurn(), peer = b.beginTurn();
  const persistent = a.allocPersistent(turn, 2), scratch = a.allocScratch(turn, 2);
  a.write(turn, persistent, Uint8Array.of(42, 9));
  a.write(turn, scratch, Uint8Array.of(7, 8));
  const copy = a.read(turn, persistent);
  copy[0] = 0;
  assert.deepEqual([...a.read(turn, persistent)], [42, 9]);
  assert.deepEqual([...a.read(turn, scratch)], [7, 8]);
  assert.throws(() => b.read(peer, persistent), /foreign or stale/);
  const destination = new Uint8Array(2);
  a.readInto(turn, persistent, destination);
  assert.deepEqual([...destination], [42, 9]);
  a.endTurn(turn);
  const next = a.beginTurn();
  assert.throws(() => a.read(turn, persistent), /turn authority/);
  assert.throws(() => a.read(next, scratch), /foreign or stale/);
  assert.deepEqual([...a.read(next, persistent)], [42, 9]);
  a.dropPersistent(next, persistent);
  const replacement = a.allocPersistent(next, 2);
  assert.deepEqual([...a.read(next, replacement)], [0, 0]);
  a.endTurn(next); b.endTurn(peer); a.retire(); b.retire();
});

test("arena owned read does not consult mutable typed-array constructor", () => {
  const a = new ActorArena({actorId: 3, incarnation: 1});
  const turn = a.beginTurn(), handle = a.allocPersistent(turn, 2);
  a.write(turn, handle, Uint8Array.of(42, 9));
  const descriptor = Object.getOwnPropertyDescriptor(Uint8Array.prototype, "constructor");
  let copy;
  try {
    Object.defineProperty(Uint8Array.prototype, "constructor", {configurable: true,
      get() { throw new Error("unexpected constructor consultation"); }});
    copy = a.read(turn, handle);
  } finally {
    Object.defineProperty(Uint8Array.prototype, "constructor", descriptor);
    a.endTurn(turn); a.retire();
  }
  assert.deepEqual([...copy], [42, 9]);
});
