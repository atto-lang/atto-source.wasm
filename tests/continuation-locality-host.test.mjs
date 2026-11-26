import test from "node:test";
import assert from "node:assert/strict";
import {ActorArena} from "../src/actor-arena.mjs";

// Host-only actor arena/lifecycle proof; this is not compiled Oreslang await.
test("persistent actor-owned data survives a yielded carrier turn, but old turn authority does not", async () => {
  const arena = new ActorArena({actorId: 91, incarnation: 7, kind: "private"});
  const original = arena.beginTurn();
  const persistent = arena.allocPersistent(original, 4);
  const scratch = arena.allocScratch(original, 4);
  arena.write(original, persistent, Uint8Array.of(1, 2, 3, 4));
  arena.write(original, scratch, Uint8Array.of(5, 6, 7, 8));
  arena.endTurn(original);
  // No physical turn guard is held across this host await boundary.
  await Promise.resolve();
  const resumed = arena.beginTurn();
  assert.throws(() => arena.read(original, persistent), /turn authority/);
  assert.deepEqual([...arena.read(resumed, persistent)], [1, 2, 3, 4]);
  assert.throws(() => arena.read(resumed, scratch), /foreign or stale/);
  arena.endTurn(resumed);
  arena.retire();
  assert.throws(() => arena.beginTurn(), /retired/);
});

test("restarted generation cannot inherit stale worker-turn or heap authority", () => {
  const retired = new ActorArena({actorId: 92, incarnation: 8});
  const token = retired.beginTurn();
  const handle = retired.allocPersistent(token, 1);
  retired.endTurn(token);
  retired.retire();

  const restarted = new ActorArena({actorId: 92, incarnation: 9});
  const now = restarted.beginTurn();
  assert.throws(() => restarted.read(now, handle), /foreign or stale/);
  assert.throws(() => retired.read(token, handle), /retired/);
  restarted.endTurn(now);
  restarted.retire();
});
