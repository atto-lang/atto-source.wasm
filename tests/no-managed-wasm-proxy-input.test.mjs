import test from 'node:test';
import assert from 'node:assert/strict';
import {assertNoManagedWasm} from '../scripts/no-managed-wasm.mjs';

const validHeader = [0, 97, 115, 109, 1, 0, 0, 0];

test('direct scanner rejects proxied typed arrays that forge Wasm bytes', () => {
  const real = new Uint8Array([255, 97, 115, 109, 1, 0, 0, 0]);
  const spoof = new Proxy(real, {
    get(target, key) {
      if (key === 'length') return target.length;
      if (typeof key === 'string' && /^[0-7]$/.test(key))
        return validHeader[Number(key)];
      return Reflect.get(target, key, target);
    }
  });
  assert.equal(spoof instanceof Uint8Array, true);
  assert.equal(ArrayBuffer.isView(spoof), false);
  assert.throws(() => assertNoManagedWasm(real), /invalid core module header/);
  assert.throws(() => assertNoManagedWasm(spoof), /invalid core module header/);
  const actual = new Uint8Array(validHeader);
  assert.equal(WebAssembly.validate(actual), true);
  assert.doesNotThrow(() => assertNoManagedWasm(actual));

  const nativeDescriptor = Object.getOwnPropertyDescriptor(ArrayBuffer, 'isView');
  try {
    Object.defineProperty(ArrayBuffer, 'isView', {
      configurable: true, writable: true, value: () => true
    });
    assert.throws(() => assertNoManagedWasm(spoof), /invalid core module header/);
    assert.doesNotThrow(() => assertNoManagedWasm(actual));
  } finally {
    Object.defineProperty(ArrayBuffer, 'isView', nativeDescriptor);
  }
});
