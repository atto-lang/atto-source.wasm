import test from "node:test";
import assert from "node:assert/strict";
import {ActorArena, actorArenaPoolStats} from "../src/actor-arena.mjs";

test("reused arena pages remain zeroed and never revive stale capabilities", () => {
  const before = actorArenaPoolStats();
  const first = new ActorArena({actorId: 90001, incarnation: 1});
  const turn = first.beginTurn();
  const stale = first.allocPersistent(turn, 16);
  first.write(turn, stale, new Uint8Array(16).fill(0xa5));
  first.endTurn(turn);
  first.retire();
  first.retire();
  const free = actorArenaPoolStats();
  assert.equal(free.leasedArenas, before.leasedArenas);
  assert.equal(free.freeArenas, before.freeArenas + 1);
  for (let i = 0; i < 128; ++i) {
    const actor = new ActorArena({actorId: 90002 + i, incarnation: i + 1});
    assert.equal(actorArenaPoolStats().committedPages, free.committedPages);
    const admitted = actor.beginTurn();
    assert.throws(() => actor.read(admitted, stale), /foreign or stale/);
    const handle = actor.allocPersistent(admitted, 16);
    assert.deepEqual([...actor.read(admitted, handle)], Array(16).fill(0));
    actor.write(admitted, handle, new Uint8Array(16).fill(i & 255));
    actor.endTurn(admitted);
    actor.retire();
    actor.retire();
    const now = actorArenaPoolStats();
    assert.equal(now.freeArenas, free.freeArenas);
    assert.equal(now.leasedArenas, before.leasedArenas);
  }
});
