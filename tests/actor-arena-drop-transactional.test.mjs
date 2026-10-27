import test from 'node:test';
import assert from 'node:assert/strict';
import {ActorArena} from '../src/actor-arena.mjs';

const PAGE = 65536;

test('dropPersistent cannot lose a segment when Array.push is poisoned', () => {
  const arena = new ActorArena({actorId: 201, incarnation: 1});
  const turn = arena.beginTurn();
  const first = arena.allocPersistent(turn, 128);
  const rest = arena.allocPersistent(turn, PAGE - 128);
  arena.write(turn, first, new Uint8Array(128).fill(77));
  const original = Array.prototype.push;
  let intercepted = 0;
  Array.prototype.push = function (...items) {
    if (items.some(x => x && typeof x === 'object' &&
        Object.hasOwn(x, 'offset') && Object.hasOwn(x, 'length'))) {
      intercepted++;
      throw Error('poisoned segment push');
    }
    return original.apply(this, items);
  };
  try {
    arena.dropPersistent(turn, first);
  } finally {
    Array.prototype.push = original;
  }
  assert.equal(intercepted, 0, 'native segment insertion bypasses patched push');
  assert.throws(() => arena.read(turn, first), /stale/);
  const reused = arena.allocPersistent(turn, 128);
  assert.deepEqual([...arena.read(turn, reused)], Array(128).fill(0));
  arena.dropPersistent(turn, reused);
  arena.dropPersistent(turn, rest);
  const whole = arena.allocPersistent(turn, PAGE);
  assert.equal(arena.read(turn, whole).length, PAGE,
    'all free segments must coalesce after repeated release');
  arena.endTurn(turn);
  arena.retire();
});

test('dropPersistent uses captured sort, zero and WeakMap revocation intrinsics', () => {
  const arena = new ActorArena({actorId: 202, incarnation: 1});
  const turn = arena.beginTurn();
  const first = arena.allocPersistent(turn, 16);
  const second = arena.allocPersistent(turn, PAGE - 16);
  arena.write(turn, first, new Uint8Array(16).fill(91));
  const originalSort = Array.prototype.sort;
  const originalFill = Uint8Array.prototype.fill;
  const originalDelete = WeakMap.prototype.delete;
  let intercepted = 0;
  Array.prototype.sort = function () {intercepted++; throw Error('poisoned sort');};
  Uint8Array.prototype.fill = function () {intercepted++; throw Error('poisoned zero');};
  WeakMap.prototype.delete = function () {intercepted++; throw Error('poisoned delete');};
  try {
    arena.dropPersistent(turn, first);
  } finally {
    Array.prototype.sort = originalSort;
    Uint8Array.prototype.fill = originalFill;
    WeakMap.prototype.delete = originalDelete;
  }
  assert.equal(intercepted, 0, 'drop must use captured host intrinsics');
  assert.throws(() => arena.read(turn, first), /stale/);
  const replacement = arena.allocPersistent(turn, 16);
  assert.deepEqual([...arena.read(turn, replacement)], Array(16).fill(0));
  arena.dropPersistent(turn, replacement);
  arena.dropPersistent(turn, second);
  assert.equal(arena.read(turn, arena.allocPersistent(turn, PAGE)).length, PAGE);
  arena.endTurn(turn);
  arena.retire();
});

test('poisoned memory getter cannot interrupt persistent release or strand quota', () => {
  const arena = new ActorArena({actorId: 203, incarnation: 1});
  const turn = arena.beginTurn();
  const handle = arena.allocPersistent(turn, 8);
  arena.write(turn, handle, Uint8Array.from([1,2,3,4,5,6,7,8]));
  const base = Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype, 'buffer');
  assert.equal(base.configurable, true);
  let reads = 0;
  Object.defineProperty(WebAssembly.Memory.prototype, 'buffer', {
    ...base,
    get() {
      reads++;
      throw Error('poisoned buffer getter');
    }
  });
  try {
    arena.dropPersistent(turn, handle);
  } finally {
    Object.defineProperty(WebAssembly.Memory.prototype, 'buffer', base);
  }
  assert.equal(reads, 0, 'native memory buffer getter must be captured');
  assert.throws(() => arena.read(turn, handle), /stale/);
  const replacement = arena.allocPersistent(turn, 8);
  assert.deepEqual([...arena.read(turn, replacement)], Array(8).fill(0));
  arena.endTurn(turn);
  arena.retire();
});
