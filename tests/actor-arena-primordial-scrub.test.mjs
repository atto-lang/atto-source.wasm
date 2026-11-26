import test from 'node:test';
import assert from 'node:assert/strict';

const NativeMemory = WebAssembly.Memory;
const NativeFill = Uint8Array.prototype.fill;
const NativeBytes = Uint8Array;

async function captureArena(actorId) {
  // The arena intentionally captures native constructors at module load.
  // Load a fresh test-only module while observing construction; never expose
  // memory from the production API or replace captured byte operations.
  let memory;
  WebAssembly.Memory = new Proxy(NativeMemory, {
    construct(target, args) { memory = Reflect.construct(target, args); return memory; }
  });
  try {
    const {ActorArena} = await import('../src/actor-arena.mjs?scrub-test=' + actorId);
    const arena = new ActorArena({actorId, incarnation: 1});
    assert.ok(memory instanceof NativeMemory, 'test must observe actual arena memory');
    return {arena, memory};
  } finally { WebAssembly.Memory = NativeMemory; }
}

test('retirement must scrub even when later host mutates Uint8Array.prototype.fill', async () => {
  const {arena, memory} = await captureArena(201);
  const turn = arena.beginTurn();
  const handle = arena.allocPersistent(turn, 4);
  arena.write(turn, handle, NativeBytes.from([7, 8, 9, 10]));
  arena.endTurn(turn);
  assert.equal(new NativeBytes(memory.buffer)[0], 7);
  Uint8Array.prototype.fill = function () { return this; };
  try { arena.retire(); }
  finally { Uint8Array.prototype.fill = NativeFill; }
  assert.equal(arena.retired, true);
  assert.deepEqual([...new NativeBytes(memory.buffer).slice(0, 4)], [0, 0, 0, 0]);
});

test('last lifetime pin release must scrub after STOP even when host fill changes', async () => {
  const {arena, memory} = await captureArena(202);
  const turn = arena.beginTurn();
  const handle = arena.allocPersistent(turn, 4);
  arena.write(turn, handle, NativeBytes.from([21, 22, 23, 24]));
  const pin = arena.pinLifetime(turn);
  arena.endTurn(turn);
  arena.retire();
  assert.deepEqual([...new NativeBytes(memory.buffer).slice(0, 4)], [21, 22, 23, 24]);
  Uint8Array.prototype.fill = function () { return this; };
  try { arena.releaseLifetimePin(pin); }
  finally { Uint8Array.prototype.fill = NativeFill; }
  assert.equal(arena.pendingLifetimePins, 0);
  assert.deepEqual([...new NativeBytes(memory.buffer).slice(0, 4)], [0, 0, 0, 0]);
});

test('scratch bytes must scrub before next turn under poisoned host fill', async () => {
  const {arena, memory} = await captureArena(203);
  const firstTurn = arena.beginTurn();
  const handle = arena.allocScratch(firstTurn, 4);
  arena.write(firstTurn, handle, NativeBytes.from([31, 32, 33, 34]));
  Uint8Array.prototype.fill = function () { return this; };
  try { arena.endTurn(firstTurn); }
  finally { Uint8Array.prototype.fill = NativeFill; }
  assert.deepEqual([...new NativeBytes(memory.buffer).slice(65536, 65540)], [0, 0, 0, 0]);
  arena.retire();
});

test('retirement uses native memory and byte-length slots after prototype corruption', async () => {
  const {arena, memory} = await captureArena(204);
  const actualBuffer = memory.buffer;
  const turn = arena.beginTurn();
  const handle = arena.allocPersistent(turn, 4);
  arena.write(turn, handle, NativeBytes.from([51, 52, 53, 54]));
  arena.endTurn(turn);
  const originalBuffer = Object.getOwnPropertyDescriptor(NativeMemory.prototype, 'buffer');
  const originalByteLength = Object.getOwnPropertyDescriptor(NativeBytes.prototype, 'byteLength');
  Object.defineProperty(NativeMemory.prototype, 'buffer', {
    configurable: true, get() { return new ArrayBuffer(131072); }
  });
  Object.defineProperty(NativeBytes.prototype, 'byteLength', {
    configurable: true, get() { return 0; }
  });
  try { arena.retire(); }
  finally {
    Object.defineProperty(NativeMemory.prototype, 'buffer', originalBuffer);
    if (originalByteLength) Object.defineProperty(NativeBytes.prototype, 'byteLength', originalByteLength);
    else delete NativeBytes.prototype.byteLength;
  }
  assert.deepEqual([...new NativeBytes(actualBuffer).slice(0, 4)], [0, 0, 0, 0]);
});

test('read and write retain native byte operations under later host monkeypatches', async () => {
  const {arena} = await captureArena(205);
  const turn = arena.beginTurn();
  const handle = arena.allocPersistent(turn, 4);
  const supplied = NativeBytes.from([71, 72, 73, 74]);
  const savedConstructor = globalThis.Uint8Array;
  const savedSet = NativeBytes.prototype.set;
  const savedSlice = NativeBytes.prototype.slice;
  let copied;
  globalThis.Uint8Array = function () { throw Error('host type replaced'); };
  NativeBytes.prototype.set = function () { throw Error('host set replaced'); };
  NativeBytes.prototype.slice = function () { throw Error('host slice replaced'); };
  try {
    arena.write(turn, handle, supplied);
    copied = arena.read(turn, handle);
  } finally {
    globalThis.Uint8Array = savedConstructor;
    NativeBytes.prototype.set = savedSet;
    NativeBytes.prototype.slice = savedSlice;
  }
  assert.deepEqual([...copied], [71, 72, 73, 74]);
  copied[0] = 99;
  assert.deepEqual([...arena.read(turn, handle)], [71, 72, 73, 74]);
  arena.endTurn(turn);
  arena.retire();
});
