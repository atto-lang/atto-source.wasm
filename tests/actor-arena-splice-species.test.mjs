import test from 'node:test';
import assert from 'node:assert/strict';
import {ActorArena} from '../src/actor-arena.mjs';

const PAGE = 65536;
function withPoisonedArraySpecies(species, action) {
  const original = Object.getOwnPropertyDescriptor(Array.prototype, 'constructor');
  assert.ok(original?.configurable);
  Object.defineProperty(Array.prototype, 'constructor', {
    ...original, value: {[Symbol.species]:species},
  });
  try { return action(); }
  finally { Object.defineProperty(Array.prototype, 'constructor', original); }
}
function prepare(actorId, holeLength) {
  const arena = new ActorArena({actorId, incarnation:1});
  const turn = arena.beginTurn();
  const released = arena.allocPersistent(turn, holeLength);
  const live = arena.allocPersistent(turn, PAGE - holeLength);
  arena.write(turn, live, new Uint8Array(PAGE - holeLength).fill(71));
  arena.dropPersistent(turn, released);
  return {arena,turn,released,live};
}

test('exact-fit reuse never invokes poisoned Array[Symbol.species]', () => {
  const {arena,turn,released,live} = prepare(701,16);
  let invoked=0, reused, failure;
  withPoisonedArraySpecies(function() {invoked++; throw Error('guest species callback');}, () => {
    try { reused = arena.allocPersistent(turn,16); }
    catch (error) { failure = error; }
  });
  assert.equal(failure, undefined, 'reusing a free segment must not execute guest species');
  assert.equal(invoked, 0);
  assert.deepEqual([...arena.read(turn,reused)], Array(16).fill(0));
  assert.throws(() => arena.read(turn,released),/stale/);
  assert.equal(arena.read(turn,live).every(x=>x===71),true);
  arena.dropPersistent(turn,reused);
  arena.dropPersistent(turn,live);
  assert.equal(arena.read(turn,arena.allocPersistent(turn,PAGE)).length,PAGE);
  arena.endTurn(turn);
  arena.retire();
});

test('hostile Array species cannot observe actor allocation after authority registration', () => {
  const {arena,turn,live} = prepare(702,8);
  let observed=0, reused, failure;
  withPoisonedArraySpecies(function (size) {
    observed++;
    assert.equal(size, 1);
    throw Error('reentrant host constructor ran');
  }, () => {
    try {reused=arena.allocPersistent(turn,8);}catch(error){failure=error;}
  });
  assert.equal(failure,undefined);
  assert.equal(observed,0);
  arena.dropPersistent(turn,reused);
  arena.dropPersistent(turn,live);
  arena.endTurn(turn);
  arena.retire();
});

test('partial free-segment reuse and coalescing remain exact under hostile species', () => {
  const {arena,turn,released,live} = prepare(703,64);
  let invoked=0, first, remainder, failure;
  withPoisonedArraySpecies(function(){invoked++;throw Error('poisoned species');},()=>{
    try {
      first=arena.allocPersistent(turn,16);
      remainder=arena.allocPersistent(turn,48);
    } catch(error){failure=error;}
  });
  assert.equal(failure,undefined);
  assert.equal(invoked,0);
  assert.throws(()=>arena.read(turn,released),/stale/);
  arena.dropPersistent(turn,first);
  arena.dropPersistent(turn,remainder);
  arena.dropPersistent(turn,live);
  const whole=arena.allocPersistent(turn,PAGE);
  assert.equal(arena.read(turn,whole).length,PAGE);
  arena.dropPersistent(turn,whole);
  arena.endTurn(turn);
  arena.retire();
});
