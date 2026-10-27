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
  let intercepted = 0, getterCalls = 0;
  assert.equal(descriptor.configurable, true);
  Object.defineProperty(WebAssembly.Memory.prototype, 'buffer', {
    ...descriptor,
    get() {getterCalls++; throw Error('poisoned memory getter');}
  });
  Uint8Array.prototype.fill = function () {intercepted++; return this;};
  try {arena.retire();}
  finally {
    Uint8Array.prototype.fill = originalFill;
    Object.defineProperty(WebAssembly.Memory.prototype, 'buffer', descriptor);
  }
  assert.equal(intercepted, 0, 'retirement must use captured zeroing');
  assert.equal(getterCalls, 0, 'retirement must use the captured native memory getter');
  assert.equal(arena.retired, true);
  assert.throws(() => arena.read(turn, handle), /retired/);
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

test('read bypasses hostile TypedArray species construction', () => {
  const arena = new ActorArena({actorId:306, incarnation:1});
  const turn = arena.beginTurn();
  const handle = arena.allocPersistent(turn, 4);
  arena.write(turn, handle, Uint8Array.from([7,8,9,10]));
  const original = Uint8Array.prototype.constructor;
  let intercepted = 0;
  Uint8Array.prototype.constructor = {
    [Symbol.species](length) {intercepted++; return new Uint8Array(length);}
  };
  let copy;
  try {copy = arena.read(turn, handle);}
  finally {Uint8Array.prototype.constructor = original;}
  assert.equal(intercepted, 0, 'read must not invoke a mutable species constructor');
  assert.deepEqual([...copy], [7,8,9,10]);
  copy[0] = 99;
  assert.deepEqual([...arena.read(turn, handle)], [7,8,9,10]);
  arena.endTurn(turn);
  arena.retire();
});

test('arena private view construction bypasses a replaced global Uint8Array', () => {
  const arena = new ActorArena({actorId:307, incarnation:1});
  const turn = arena.beginTurn();
  const handle = arena.allocPersistent(turn, 4);
  const Original = globalThis.Uint8Array;
  let intercepted = 0;
  globalThis.Uint8Array = class extends Original {
    constructor(...args) {super(...args); intercepted++;}
  };
  let copy;
  try {
    arena.write(turn, handle, Original.from([3,5,7,9]));
    copy = arena.read(turn, handle);
  } finally {globalThis.Uint8Array = Original;}
  assert.equal(intercepted, 0, 'arena must not invoke replaced global constructors');
  assert.deepEqual([...copy], [3,5,7,9]);
  arena.endTurn(turn);
  arena.retire();
});

test('private memory getter cannot redirect owned read, write or zeroing', () => {
  const arena = new ActorArena({actorId:308, incarnation:1});
  const turn = arena.beginTurn();
  const handle = arena.allocPersistent(turn, 4);
  const descriptor = Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype, 'buffer');
  const decoy = new ArrayBuffer(2 * 65536);
  new Uint8Array(decoy).fill(123);
  let getterCalls = 0;
  Object.defineProperty(WebAssembly.Memory.prototype, 'buffer', {
    ...descriptor,
    get() {getterCalls++; return decoy;}
  });
  try {
    arena.write(turn, handle, Uint8Array.from([1,2,3,4]));
    assert.deepEqual([...arena.read(turn, handle)], [1,2,3,4]);
    arena.dropPersistent(turn, handle);
    const reused = arena.allocPersistent(turn, 4);
    assert.deepEqual([...arena.read(turn, reused)], [0,0,0,0]);
    arena.endTurn(turn);
    arena.retire();
  } finally {
    Object.defineProperty(WebAssembly.Memory.prototype, 'buffer', descriptor);
  }
  assert.equal(getterCalls, 0, 'private bytes must never consult a mutable getter');
  assert.equal(new Uint8Array(decoy).every(byte => byte === 123), true,
    'unrelated host buffer must never be used as private actor memory');
});

test('replacing global WebAssembly.Memory cannot capture actor private memory', () => {
  const Original = WebAssembly.Memory;
  let intercepted = 0;
  WebAssembly.Memory = class extends Original {
    constructor(...args) {super(...args);intercepted++;}
  };
  let arena;
  try {
    arena = new ActorArena({actorId:309, incarnation:1});
    const turn = arena.beginTurn();
    const handle = arena.allocPersistent(turn, 4);
    arena.write(turn, handle, Uint8Array.from([9,8,7,6]));
    assert.deepEqual([...arena.read(turn, handle)], [9,8,7,6]);
    arena.endTurn(turn);
    arena.retire();
  } finally {
    WebAssembly.Memory = Original;
  }
  assert.equal(intercepted, 0, 'actor must use captured native memory constructor');
});


test('host mutation of Number.isSafeInteger cannot admit invalid owners or arena lengths', () => {
  const arena = new ActorArena({actorId:310, incarnation:1});
  const turn = arena.beginTurn();
  const original = Number.isSafeInteger;
  let intercepted = 0;
  let ownerRejected = false, persistentRejected = false, scratchRejected = false;
  Number.isSafeInteger = () => {intercepted++; return true;};
  try {
    try {new ActorArena({actorId:NaN, incarnation:1});}
    catch (error) {ownerRejected = error instanceof TypeError;}
    try {arena.allocPersistent(turn, NaN);}
    catch (error) {persistentRejected = error instanceof RangeError;}
    try {arena.allocScratch(turn, Infinity);}
    catch (error) {scratchRejected = error instanceof RangeError;}
  } finally {
    Number.isSafeInteger = original;
  }
  assert.equal(intercepted, 0, 'validation must use captured safe-integer intrinsic');
  assert.equal(ownerRejected, true, 'NaN actor identity must fail closed');
  assert.equal(persistentRejected, true, 'NaN cannot poison persistent high-water accounting');
  assert.equal(scratchRejected, true, 'Infinity cannot poison scratch high-water accounting');
  const valid = arena.allocPersistent(turn, 4);
  arena.write(turn, valid, Uint8Array.from([1,2,3,4]));
  assert.deepEqual([...arena.read(turn, valid)], [1,2,3,4]);
  arena.endTurn(turn);
  arena.retire();
});

test('host mutation of Set.has cannot admit unsupported actor kinds', () => {
  const original = Set.prototype.has;
  let intercepted = 0, rejected = false;
  Set.prototype.has = function () {intercepted++; return true;};
  try {
    try {new ActorArena({actorId:311, incarnation:1, kind:'unsupported-source-actor'});}
    catch (error) {rejected = error instanceof TypeError;}
  } finally {
    Set.prototype.has = original;
  }
  assert.equal(intercepted, 0, 'kind admission must use captured Set.has');
  assert.equal(rejected, true, 'unsupported actor kind must remain denied');
});

test('host mutation of Object.freeze cannot forge an admitted actor turn', () => {
  const arena = new ActorArena({actorId:312, incarnation:1});
  const original = Object.freeze;
  const forged = {};
  let intercepted = 0, turn;
  Object.freeze = () => {intercepted++; return forged;};
  try {turn = arena.beginTurn();}
  finally {Object.freeze = original;}
  let forgedAccepted = false;
  try {arena.allocPersistent(forged, 4); forgedAccepted = true;}
  catch (error) {assert.match(String(error), /actor turn authority required/);}
  assert.equal(intercepted, 0, 'turn token must use captured native freeze');
  assert.notEqual(turn, forged, 'external object must not become the turn authority');
  assert.equal(Object.isFrozen(turn), true, 'admitted turn remains opaque and frozen');
  assert.equal(forgedAccepted, false, 'forged host object cannot allocate actor memory');
  const valid = arena.allocPersistent(turn, 4);
  assert.equal(arena.read(turn, valid).length, 4);
  arena.endTurn(turn);
  arena.retire();
});
