import test from 'node:test';
import assert from 'node:assert/strict';
import {ActorArena} from '../src/actor-arena.mjs';

test('persistent release never consults inherited negative-index metadata', () => {
  const arena = new ActorArena({actorId:401, incarnation:1});
  const turn = arena.beginTurn();
  const released = arena.allocPersistent(turn, 32768);
  const live = arena.allocPersistent(turn, 32768);
  arena.write(turn, live, new Uint8Array(32768).fill(73));
  let calls = 0;
  let failure;
  const prior = Object.getOwnPropertyDescriptor(Array.prototype, '-1');
  Object.defineProperty(Array.prototype, '-1', {configurable:true, get() {
    ++calls;
    throw new Error('inherited allocator metadata executed');
  }});
  try { arena.dropPersistent(turn, released); }
  catch (error) { failure = error; }
  finally {
    if (prior) Object.defineProperty(Array.prototype, '-1', prior);
    else delete Array.prototype['-1'];
  }
  assert.equal(calls, 0);
  assert.equal(failure, undefined);
  const reused = arena.allocPersistent(turn, 32768);
  assert.ok(arena.read(turn, reused).every(byte => byte === 0));
  assert.ok(arena.read(turn, live).every(byte => byte === 73));
  assert.throws(() => arena.read(turn, released), /stale/);
  arena.endTurn(turn);
  arena.retire();
});
