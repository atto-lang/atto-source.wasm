import test from "node:test";
import assert from "node:assert/strict";
import {ActorArena} from "../src/actor-arena.mjs";

test("Wasm actor span get returns Some(owned copy) or None without raw alias", () => {
  const arena = new ActorArena({actorId: 701, incarnation: 1});
  const turn = arena.beginTurn();
  const handle = arena.allocPersistent(turn, 4);
  arena.write(turn, handle, Uint8Array.of(1, 2, 3, 4));
  const hit = arena.tryReadBytes(turn, handle, 1, 2);
  assert.equal(hit.kind, "Some");
  assert.deepEqual([...hit.value], [2, 3]);
  assert.equal(Object.isFrozen(hit), true);
  hit.value[0] = 99;
  assert.deepEqual([...arena.read(turn, handle)], [1, 2, 3, 4]);
  const last = arena.tryReadBytes(turn, handle, 3n, 1n);
  assert.deepEqual([...last.value], [4]);
  const zero = arena.tryReadBytes(turn, handle, 4, 0);
  assert.equal(zero.kind, "Some");
  assert.equal(zero.value.length, 0);
  for (const [start, width] of [[-1,1],[0,-1],[4,1],[5,0],[3,2],
    [0,5], [0xffff_ffffn,1], [(1n<<63n)-1n,1]]) {
    assert.deepEqual(arena.tryReadBytes(turn, handle, start, width), {kind:"None"});
  }
  assert.deepEqual([...arena.read(turn, handle)], [1, 2, 3, 4]);
  arena.endTurn(turn);
  arena.retire();
});

test("invalid indices cannot coerce into a valid Wasm byte access", () => {
  const arena = new ActorArena({actorId: 702, incarnation: 1});
  const turn = arena.beginTurn(), handle = arena.allocPersistent(turn, 2);
  for (const x of [NaN,Infinity,-0,0.5,"0",null,undefined,
    Number.MAX_SAFE_INTEGER+1]) {
    assert.throws(() => arena.tryReadBytes(turn, handle, x, 1), TypeError);
    assert.throws(() => arena.tryReadBytes(turn, handle, 0, x), TypeError);
  }
  arena.endTurn(turn);
  arena.retire();
});

test("actor turn, incarnation and stale handle failures precede optional miss", () => {
  const a = new ActorArena({actorId: 703, incarnation: 1});
  const b = new ActorArena({actorId: 703, incarnation: 2});
  const ta = a.beginTurn(), tb = b.beginTurn();
  const ha = a.allocPersistent(ta, 1);
  assert.throws(() => a.tryReadBytes(tb, ha, -1, 1), /turn authority/);
  assert.throws(() => b.tryReadBytes(tb, ha, -1, 1), /foreign or stale/);
  a.dropPersistent(ta, ha);
  assert.throws(() => a.tryReadBytes(ta, ha, -1, 1), /foreign or stale/);
  a.endTurn(ta);
  b.endTurn(tb);
  a.retire();
  b.retire();
  assert.throws(() => a.tryReadBytes(ta, ha, -1, 1), /retired/);
});

test("scratch span expires at actor turn and cannot reappear on next turn", () => {
  const a = new ActorArena({actorId: 704, incarnation: 1});
  const t = a.beginTurn();
  const old = a.allocScratch(t, 8);
  a.write(t, old, Uint8Array.of(1,2,3,4,5,6,7,8));
  assert.deepEqual([...a.tryReadBytes(t, old, 2, 3).value], [3,4,5]);
  a.endTurn(t);
  const next = a.beginTurn();
  assert.throws(() => a.tryReadBytes(next, old, 20, 1), /foreign or stale/);
  a.endTurn(next);
  a.retire();
});
