import test from "node:test";
import assert from "node:assert/strict";
import {ActorArena} from "../src/actor-arena.mjs";

// Shared arena lifecycle v1: failed admission is accounting-neutral;
// retirement and reuse of one private arena cannot affect a sibling.
test("quota rejection preserves remaining capacity and sibling bytes", () => {
  const a = new ActorArena({actorId: 701, incarnation: 1});
  const b = new ActorArena({actorId: 702, incarnation: 1});
  const ta = a.beginTurn();
  const tb = b.beginTurn();
  const first = a.allocPersistent(ta, 65528);
  const sibling = b.allocPersistent(tb, 4);
  a.write(ta, first, new Uint8Array(65528).fill(17));
  b.write(tb, sibling, Uint8Array.of(9, 8, 7, 6));
  for (let i = 0; i < 8; i++) {
    assert.throws(() => a.allocPersistent(ta, 9), /quota exhausted/);
  }
  const tail = a.allocPersistent(ta, 8);
  assert.deepEqual(a.read(ta, tail), new Uint8Array(8));
  assert.deepEqual(a.read(ta, first), new Uint8Array(65528).fill(17));
  assert.throws(() => a.allocPersistent(ta, 1), /quota exhausted/);
  const scratch = a.allocScratch(ta, 8);
  assert.deepEqual(a.read(ta, scratch), new Uint8Array(8));
  a.endTurn(ta);
  a.retire();
  assert.deepEqual(b.read(tb, sibling), Uint8Array.of(9, 8, 7, 6));
  const restarted = new ActorArena({actorId: 701, incarnation: 2});
  const tr = restarted.beginTurn();
  assert.throws(() => restarted.read(tr, first), /foreign or stale/);
  const fresh = restarted.allocPersistent(tr, 65536);
  assert.deepEqual(restarted.read(tr, fresh), new Uint8Array(65536));
  restarted.endTurn(tr);
  restarted.retire();
  b.endTurn(tb);
  b.retire();
});
