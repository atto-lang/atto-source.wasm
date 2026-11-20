import test from 'node:test';
import assert from 'node:assert/strict';
import {scrubFixedGuestMemory} from '../src/pooled-actor-guest-scrub.mjs';

const PAGE = 65536;

test('STOP physically scrubs the entire 2-page guest memory', () => {
  const memory = new WebAssembly.Memory({initial: 2, maximum: 2});
  const view = new Uint8Array(memory.buffer);
  view.fill(37);
  view[0] = 5; view[PAGE - 1] = 255; view[PAGE] = 99; view[2 * PAGE - 1] = 123;
  assert.equal(scrubFixedGuestMemory(memory), true);
  assert.equal(view.byteLength, 2 * PAGE);
  for (const byte of view) assert.equal(byte, 0);
});

test('native scrub survives monkeypatching the public Uint8Array.fill method', () => {
  const memory = new WebAssembly.Memory({initial: 2, maximum: 2});
  const before = Uint8Array.prototype.fill;
  new Uint8Array(memory.buffer).set([1,2,3,4], 64);
  try {
    Uint8Array.prototype.fill = function () {throw Error('tampered fill');};
    assert.equal(scrubFixedGuestMemory(memory), true);
    assert.deepEqual(Array.from(new Uint8Array(memory.buffer, 64, 4)), [0,0,0,0]);
  } finally {
    Uint8Array.prototype.fill = before;
  }
});

test('rejects wrong-size, forged, shared, or non-Wasm memory without ACK', () => {
  for (const pages of [1, 3]) {
    const memory = new WebAssembly.Memory({initial: pages, maximum: pages});
    assert.throws(() => scrubFixedGuestMemory(memory), /exactly two/);
  }
  assert.throws(() => scrubFixedGuestMemory({buffer:new ArrayBuffer(2*PAGE)}),
    /private guest Wasm memory/);
  assert.throws(() => scrubFixedGuestMemory(Object.create(WebAssembly.Memory.prototype)));
  if (typeof SharedArrayBuffer !== 'undefined') {
    const shared = new WebAssembly.Memory({initial: 2, maximum: 2, shared: true});
    assert.throws(() => scrubFixedGuestMemory(shared), /shared backing/);
  }
});
