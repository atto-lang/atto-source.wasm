import test from 'node:test';
import assert from 'node:assert/strict';
import {assertNoManagedWasm} from '../scripts/no-managed-wasm.mjs';

const name = str => [str.length, ...new TextEncoder().encode(str)];
const section = (id, body) => [id, body.length, ...body];
function guest(localType) {
  // Genuine validated module, bounded private memory, no imports or tables.
  const code = [1, 6, 1, 1, localType, 0x42, 42, 0x0b];
  const bytes = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0,
    ...section(1, [1, 0x60, 0, 1, 0x7e]),
    ...section(3, [1, 0]),
    ...section(5, [1, 1, 1, 2]),
    ...section(7, [2, ...name('main'), 0, 0, ...name('memory'), 2, 0]),
    ...section(10, code)]);
  assert.equal(WebAssembly.validate(bytes), true);
  return bytes;
}

test('real Uint8Array subclass cannot truncate scan by forging length', () => {
  const forbidden = guest(0x70); // unused funcref local, valid engine Wasm
  class ShortLength extends Uint8Array { get length() { return 8; } }
  const cloaked = new ShortLength(forbidden);
  assert.equal(ArrayBuffer.isView(cloaked), true);
  assert.equal(cloaked instanceof Uint8Array, true);
  assert.equal(WebAssembly.validate(cloaked), true);
  assert.equal(cloaked.length, 8);
  assert.throws(() => assertNoManagedWasm(forbidden), /managed reference.*forbidden/);
  assert.throws(() => assertNoManagedWasm(cloaked), /managed reference.*forbidden/);
});

test('dynamically forged lengths cannot affect scan or admit invalid header', () => {
  class ChangingLength extends Uint8Array {
    get length() { this.reads = (this.reads ?? 0) + 1; return this.reads % 2 ? super.length : 8; }
  }
  const forbidden = new ChangingLength(guest(0x70));
  assert.throws(() => assertNoManagedWasm(forbidden), /managed reference.*forbidden/);
  class TinyLength extends Uint8Array { get length() { return 8; } }
  const malformed = new TinyLength([255, 97, 115, 109, 1, 0, 0, 0, 1, 1, 0]);
  assert.throws(() => assertNoManagedWasm(malformed), /invalid core module header/);
});

test('valid scalar guest and post-import typed-array length monkeypatch', () => {
  const scalar = guest(0x7f);
  class ShortLength extends Uint8Array { get length() { return 8; } }
  const cloakedScalar = new ShortLength(scalar);
  assert.doesNotThrow(() => assertNoManagedWasm(scalar));
  assert.doesNotThrow(() => assertNoManagedWasm(cloakedScalar));
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
  const original = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'length');
  try {
    Object.defineProperty(typedArrayPrototype, 'length', {
      configurable: true, get() { return 8; }
    });
    assert.throws(() => assertNoManagedWasm(guest(0x70)), /managed reference.*forbidden/);
    assert.doesNotThrow(() => assertNoManagedWasm(scalar));
  } finally {
    Object.defineProperty(typedArrayPrototype, 'length', original);
  }
});
