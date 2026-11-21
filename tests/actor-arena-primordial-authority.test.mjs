import test from 'node:test';
import assert from 'node:assert/strict';
import {types} from 'node:util';
import {ActorArena} from '../src/actor-arena.mjs';

test('replacing WeakMap cannot merge persistent authority across arenas', () => {
  const Original = globalThis.WeakMap;
  const shared = new Original();
  let a, b, ta, tb, ha, hb;
  globalThis.WeakMap = class { constructor() { return shared; } };
  try {
    a = new ActorArena({actorId:701, incarnation:1});
    b = new ActorArena({actorId:702, incarnation:1});
    ta = a.beginTurn(); tb = b.beginTurn();
    ha = a.allocPersistent(ta, 4); hb = b.allocPersistent(tb, 4);
    a.write(ta, ha, Uint8Array.from([1,2,3,4]));
    b.write(tb, hb, Uint8Array.from([9,8,7,6]));
  } finally { globalThis.WeakMap = Original; }
  try {
    assert.throws(() => b.read(tb, ha), /foreign|stale/);
    assert.throws(() => a.read(ta, hb), /foreign|stale/);
    assert.deepEqual([...a.read(ta, ha)], [1,2,3,4]);
    assert.deepEqual([...b.read(tb, hb)], [9,8,7,6]);
  } finally { a.endTurn(ta); b.endTurn(tb); a.retire(); b.retire(); }
});

test('scratch reset cannot install a shared authority registry', () => {
  const Original = globalThis.WeakMap;
  const shared = new Original();
  const a = new ActorArena({actorId:703, incarnation:1});
  const b = new ActorArena({actorId:704, incarnation:1});
  const firstA = a.beginTurn(), firstB = b.beginTurn();
  globalThis.WeakMap = class { constructor() { return shared; } };
  try { a.endTurn(firstA); b.endTurn(firstB); }
  finally { globalThis.WeakMap = Original; }
  const ta = a.beginTurn(), tb = b.beginTurn();
  const ha = a.allocScratch(ta, 4), hb = b.allocScratch(tb, 4);
  try {
    a.write(ta, ha, Uint8Array.from([1,3,5,7]));
    b.write(tb, hb, Uint8Array.from([2,4,6,8]));
    assert.throws(() => b.read(tb, ha), /foreign|stale/);
    assert.throws(() => a.read(ta, hb), /foreign|stale/);
  } finally { a.endTurn(ta); b.endTurn(tb); a.retire(); b.retire(); }
});

test('mutable util predicate cannot admit shared backing memory', () => {
  const arena = new ActorArena({actorId:705, incarnation:1});
  const turn = arena.beginTurn(), handle = arena.allocPersistent(turn, 4);
  arena.write(turn, handle, Uint8Array.from([1,2,3,4]));
  const shared = new Uint8Array(new SharedArrayBuffer(4));
  shared.fill(99);
  const original = types.isSharedArrayBuffer;
  let calls = 0;
  types.isSharedArrayBuffer = () => { calls++; return false; };
  try {
    assert.throws(() => arena.write(turn, handle, shared), /shared backing/);
  } finally { types.isSharedArrayBuffer = original; }
  try {
    assert.equal(calls, 0);
    assert.deepEqual([...arena.read(turn, handle)], [1,2,3,4]);
  } finally { arena.endTurn(turn); arena.retire(); }
});

test('valid writes do not invoke a replaced util type predicate', () => {
  const arena = new ActorArena({actorId:706, incarnation:1});
  const turn = arena.beginTurn(), handle = arena.allocPersistent(turn, 4);
  const original = types.isUint8Array;
  types.isUint8Array = () => { throw new Error('replaced type predicate'); };
  try {
    assert.doesNotThrow(() => arena.write(turn, handle, Uint8Array.from([4,3,2,1])));
  } finally { types.isUint8Array = original; }
  try { assert.deepEqual([...arena.read(turn, handle)], [4,3,2,1]); }
  finally { arena.endTurn(turn); arena.retire(); }
});
