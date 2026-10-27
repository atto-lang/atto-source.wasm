import test from 'node:test';
import assert from 'node:assert/strict';
import {ActorArena} from '../src/actor-arena.mjs';

// Host-only arena: monkeypatching a shared-realm prototype must not turn an
// owned read into a live alias or skip private-memory writes/zeroing.
test('read remains an owned copy when Uint8Array.slice is replaced', () => {
  const arena = new ActorArena({actorId:301, incarnation:1});
  const turn = arena.beginTurn();
  const handle = arena.allocPersistent(turn, 4);
  arena.write(turn, handle, Uint8Array.from([11,22,33,44]));
  const original = Uint8Array.prototype.slice;
  let intercepted = 0;
  Uint8Array.prototype.slice = function (start, end) {
    intercepted++;
    return this.subarray(start, end); // a live alias, not a copy
  };
  let result;
  try {result = arena.read(turn, handle);}
  finally {Uint8Array.prototype.slice = original;}
  assert.equal(intercepted, 0, 'private memory must not enter a patched slice');
  assert.deepEqual([...result], [11,22,33,44]);
  result[0] = 99;
  assert.deepEqual([...arena.read(turn, handle)], [11,22,33,44]);
  arena.endTurn(turn);
  arena.retire();
});

test('write uses native typed-array copy, never a patched set with private view', () => {
  const arena = new ActorArena({actorId:302, incarnation:1});
  const turn = arena.beginTurn();
  const handle = arena.allocPersistent(turn, 4);
  const original = Uint8Array.prototype.set;
  let intercepted = 0;
  let leaked = null;
  Uint8Array.prototype.set = function () {
    intercepted++;
    leaked = this;
  };
  try {arena.write(turn, handle, Uint8Array.from([1,2,3,4]));}
  finally {Uint8Array.prototype.set = original;}
  assert.equal(intercepted, 0, 'private memory must not enter a patched set');
  assert.equal(leaked, null);
  assert.deepEqual([...arena.read(turn, handle)], [1,2,3,4]);
  arena.endTurn(turn);
  arena.retire();
});

test('scratch bytes are zeroed across turns despite a patched fill', () => {
  const arena = new ActorArena({actorId:303, incarnation:1});
  const turn = arena.beginTurn();
  const handle = arena.allocScratch(turn, 4);
  arena.write(turn, handle, Uint8Array.from([9,8,7,6]));
  const original = Uint8Array.prototype.fill;
  let intercepted = 0;
  Uint8Array.prototype.fill = function () {intercepted++; return this;};
  try {arena.endTurn(turn);}
  finally {Uint8Array.prototype.fill = original;}
  assert.equal(intercepted, 0, 'turn retirement must use captured zeroing');
  const next = arena.beginTurn();
  assert.deepEqual([...arena.read(next, arena.allocScratch(next, 4))], [0,0,0,0]);
  arena.endTurn(next);
  arena.retire();
});

test('retire zeros the entire private backing buffer despite patched fill', () => {
  const arena = new ActorArena({actorId:304, incarnation:1});
  const turn = arena.beginTurn();
  const handle = arena.allocPersistent(turn, 4);
  arena.write(turn, handle, Uint8Array.from([5,6,7,8]));
  arena.endTurn(turn);
  const originalFill = Uint8Array.prototype.fill;
  const descriptor = Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype, 'buffer');
  let captured = null, intercepted = 0;
  assert.equal(descriptor.configurable, true);
  Object.defineProperty(WebAssembly.Memory.prototype, 'buffer', {
    ...descriptor,
    get() {captured = descriptor.get.call(this); return captured;}
  });
  Uint8Array.prototype.fill = function () {intercepted++; return this;};
  try {arena.retire();}
  finally {
    Uint8Array.prototype.fill = originalFill;
    Object.defineProperty(WebAssembly.Memory.prototype, 'buffer', descriptor);
  }
  assert.equal(intercepted, 0, 'retirement must use captured zeroing');
  assert.ok(captured);
  assert.equal(new Uint8Array(captured).some(byte => byte !== 0), false);
  assert.equal(arena.retired, true);
});

test('handle lookup bypasses a forged WeakMap.get slot', () => {
  const arena = new ActorArena({actorId:305, incarnation:1});
  const turn = arena.beginTurn();
  const handle = arena.allocPersistent(turn, 4);
  arena.write(turn, handle, Uint8Array.from([2,4,6,8]));
  const original = WeakMap.prototype.get;
  let intercepted = 0;
  WeakMap.prototype.get = function () {
    intercepted++;
    return {offset:128, length:4};
  };
  let result;
  try {result = arena.read(turn, handle);}
  finally {WeakMap.prototype.get = original;}
  assert.equal(intercepted, 0, 'host slot authority must not use patched WeakMap.get');
  assert.deepEqual([...result], [2,4,6,8]);
  arena.endTurn(turn);
  arena.retire();
});
