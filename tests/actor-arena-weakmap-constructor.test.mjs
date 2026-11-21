import test from 'node:test';
import assert from 'node:assert/strict';
import {ActorArena} from '../src/actor-arena.mjs';

const PAGE = 65536;

// Same-realm guest code can replace global constructors after this module
// loads; it must not receive a reference to the private handle registries.
function withLeakingWeakMap(action) {
  const original = globalThis.WeakMap;
  const captured = [];
  globalThis.WeakMap = class extends original {
    constructor(...args) {
      super(...args);
      captured.push(this);
    }
  };
  try { action(); }
  finally { globalThis.WeakMap = original; }
  return captured;
}

test('actor construction never exposes its private WeakMap registries', () => {
  let arena, turn, handle;
  const captured = withLeakingWeakMap(() => {
    arena = new ActorArena({actorId:801, incarnation:1});
    turn = arena.beginTurn();
    handle = arena.allocPersistent(turn,4);
  });
  assert.equal(captured.length,0,'untrusted constructor must not capture persistent or scratch registries');
  arena.write(turn,handle,Uint8Array.of(2,4,6,8));
  assert.deepEqual([...arena.read(turn,handle)],[2,4,6,8]);
  arena.dropPersistent(turn,handle);
  arena.endTurn(turn);
  arena.retire();
});

test('endTurn cannot hand scratch-map authority to a replacement WeakMap constructor', () => {
  const arena = new ActorArena({actorId:802, incarnation:1});
  const first = arena.beginTurn();
  const old = arena.allocScratch(first,4);
  arena.write(first,old,Uint8Array.of(1,1,1,1));
  const captured = withLeakingWeakMap(() => arena.endTurn(first));
  const next = arena.beginTurn();
  const owned = arena.allocScratch(next,4);
  arena.write(next,owned,Uint8Array.of(9,8,7,6));
  const forged = Object.freeze({});
  if (captured.length) {
    // This succeeds on the vulnerable implementation: captured[0] is the
    // private scratch WeakMap created by endTurn in the next actor turn.
    captured[0].set(forged,{offset:PAGE,length:4});
  }
  assert.throws(() => arena.read(next,forged),/foreign or stale arena handle/,
    'guest must not inject a forged slot into the next turn');
  assert.equal(captured.length,0,'turn reset must use a pinned native constructor');
  assert.deepEqual([...arena.read(next,owned)],[9,8,7,6]);
  arena.endTurn(next);
  arena.retire();
});

test('retire cannot be interrupted by a replaced WeakMap constructor', () => {
  const arena = new ActorArena({actorId:803, incarnation:1});
  const turn = arena.beginTurn();
  const handle = arena.allocPersistent(turn,8);
  arena.write(turn,handle,new Uint8Array(8).fill(7));
  arena.endTurn(turn);
  const original = globalThis.WeakMap;
  let constructorCalls = 0;
  globalThis.WeakMap = class extends original {
    constructor(...args) {
      super(...args);
      constructorCalls++;
      throw Error('poisoned WeakMap constructor');
    }
  };
  try { assert.doesNotThrow(() => arena.retire()); }
  finally { globalThis.WeakMap = original; }
  assert.equal(constructorCalls,0,'retirement must not consult a replaced constructor');
  assert.equal(arena.retired,true);
  assert.throws(() => arena.read(turn,handle),/retired/);
});
