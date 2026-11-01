import test from 'node:test';
import assert from 'node:assert/strict';
import {ActorArena} from '../src/actor-arena.mjs';

// These are real host ActorArena tests, NOT compiled .ores/Wasmtime guest proof.
const make = (actorId, incarnation = 1) =>
  new ActorArena({actorId, incarnation, kind: 'private'});
const bytes = (...xs) => Uint8Array.from(xs);

test('two independent actor-owned memories can both use offset zero without aliasing', () => {
  const a = make(901), b = make(902);
  const at = a.beginTurn(), bt = b.beginTurn();
  const ah = a.allocPersistent(at, 4), bh = b.allocPersistent(bt, 4);
  a.write(at, ah, bytes(1, 2, 3, 4));
  b.write(bt, bh, bytes(5, 6, 7, 8));
  assert.deepEqual([...a.read(at, ah)], [1, 2, 3, 4]);
  assert.deepEqual([...b.read(bt, bh)], [5, 6, 7, 8]);
  assert.throws(() => a.read(at, bh), /foreign|stale/);
  assert.throws(() => b.write(bt, ah, bytes(0, 0, 0, 0)), /foreign|stale/);
  assert.deepEqual([...a.read(at, ah)], [1, 2, 3, 4]);
  assert.deepEqual([...b.read(bt, bh)], [5, 6, 7, 8]);
  a.endTurn(at); b.endTurn(bt);
  a.retire(); b.retire();
});

test('one actor retiring cannot revoke or rewrite its surviving neighbor', () => {
  const a = make(903), b = make(904);
  const at = a.beginTurn(), bt = b.beginTurn();
  const ah = a.allocPersistent(at, 2), bh = b.allocPersistent(bt, 2);
  a.write(at, ah, bytes(8, 9)); b.write(bt, bh, bytes(13, 14));
  assert.throws(() => a.retire(), /active actor turn/);
  assert.deepEqual([...a.read(at, ah)], [8, 9]);
  a.endTurn(at); a.retire();
  assert.throws(() => a.beginTurn(), /retired/);
  b.write(bt, bh, bytes(15, 16));
  assert.deepEqual([...b.read(bt, bh)], [15, 16]);
  b.endTurn(bt);
  const next = b.beginTurn();
  assert.deepEqual([...b.read(next, bh)], [15, 16]);
  b.endTurn(next); b.retire();
});

test('restarted actor incarnation cannot consume predecessor handles or turns', () => {
  const old = make(905, 1), restarted = make(905, 2);
  const oldTurn = old.beginTurn();
  const staleHandle = old.allocPersistent(oldTurn, 3);
  old.write(oldTurn, staleHandle, bytes(1, 1, 1));
  old.endTurn(oldTurn); old.retire();
  const currentTurn = restarted.beginTurn();
  assert.throws(() => restarted.read(currentTurn, staleHandle), /foreign|stale/);
  assert.throws(() => restarted.allocPersistent(oldTurn, 1), /turn authority/);
  const fresh = restarted.allocPersistent(currentTurn, 3);
  assert.deepEqual([...restarted.read(currentTurn, fresh)], [0, 0, 0]);
  restarted.write(currentTurn, fresh, bytes(2, 2, 2));
  assert.throws(() => old.read(oldTurn, staleHandle), /retired/);
  restarted.endTurn(currentTurn); restarted.retire();
});

test('actor turn tickets are not transferable between independent arenas', () => {
  const a = make(906), b = make(907);
  const at = a.beginTurn(), bt = b.beginTurn();
  assert.throws(() => b.allocPersistent(at, 1), /turn authority/);
  assert.throws(() => a.allocScratch(bt, 1), /turn authority/);
  assert.throws(() => a.endTurn(bt), /turn authority/);
  const ah = a.allocPersistent(at, 1);
  assert.throws(() => b.read(bt, ah), /foreign|stale/);
  a.endTurn(at); b.endTurn(bt); a.retire(); b.retire();
});

test('guest input aliases cannot mutate actor-owned memory after copying', () => {
  const a = make(908), turn = a.beginTurn();
  const h = a.allocPersistent(turn, 3);
  const caller = bytes(17, 18, 19);
  a.write(turn, h, caller);
  caller.fill(0);
  assert.deepEqual([...a.read(turn, h)], [17, 18, 19]);
  const returned = a.read(turn, h);
  returned.fill(255);
  assert.deepEqual([...a.read(turn, h)], [17, 18, 19]);
  a.endTurn(turn); a.retire();
});

test('scratch loan is revoked and zero-filled between actor turns', () => {
  const a = make(909), first = a.beginTurn();
  const scratch = a.allocScratch(first, 4);
  a.write(first, scratch, bytes(21, 22, 23, 24));
  a.endTurn(first);
  const second = a.beginTurn();
  assert.throws(() => a.read(second, scratch), /foreign|stale/);
  const fresh = a.allocScratch(second, 4);
  assert.deepEqual([...a.read(second, fresh)], [0, 0, 0, 0]);
  assert.throws(() => a.read(first, fresh), /turn authority/);
  a.endTurn(second); a.retire();
});

test('quota denial in one actor leaves other actor heap unmodified', () => {
  const a = make(910), b = make(911);
  const at = a.beginTurn(), bt = b.beginTurn();
  a.allocPersistent(at, 65536);
  const bh = b.allocPersistent(bt, 2);
  b.write(bt, bh, bytes(51, 52));
  assert.throws(() => a.allocPersistent(at, 1), /quota exhausted/);
  assert.deepEqual([...b.read(bt, bh)], [51, 52]);
  assert.deepEqual([...a.read(at, a.allocScratch(at, 2))], [0, 0]);
  a.endTurn(at); b.endTurn(bt); a.retire(); b.retire();
});

test('same actor identity in distinct host arenas does not confer heap authority', () => {
  const a = make(912, 1), other = make(912, 1);
  const at = a.beginTurn(), bt = other.beginTurn();
  const ah = a.allocPersistent(at, 2);
  a.write(at, ah, bytes(31, 32));
  assert.throws(() => other.read(bt, ah), /foreign|stale/);
  assert.throws(() => other.write(bt, ah, bytes(1, 2)), /foreign|stale/);
  assert.deepEqual([...a.read(at, ah)], [31, 32]);
  a.endTurn(at); other.endTurn(bt); a.retire(); other.retire();
});
