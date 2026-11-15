import test from 'node:test';
import assert from 'node:assert/strict';
import {assertNoManagedWasm} from '../scripts/no-managed-wasm.mjs';

// Genuine scalar guest: () -> i64, one bounded memory, no imports or tables.
// The only difference is a numeric i32 local vs. an unused funcref local.
const name = str => [str.length, ...new TextEncoder().encode(str)];
const section = (id, body) => [id, body.length, ...body];
function guest(localType) {
  const code = [1, 6, 1, 1, localType, 0x42, 42, 0x0b];
  const bytes = new Uint8Array([0,97,115,109,1,0,0,0,
    ...section(1,[1,0x60,0,1,0x7e]),
    ...section(3,[1,0]),
    ...section(5,[1,1,1,2]),
    ...section(7,[2,...name('main'),0,0,...name('memory'),2,0]),
    ...section(10,code)]);
  assert.equal(WebAssembly.validate(bytes), true);
  return bytes;
}

test('deny real funcref locals despite monkeypatched Array.prototype.includes', () => {
  const allowed = guest(0x7f);
  const forbidden = guest(0x70);
  assert.doesNotThrow(() => assertNoManagedWasm(allowed));
  assert.throws(() => assertNoManagedWasm(forbidden), /managed reference.*forbidden/);
  const original = Object.getOwnPropertyDescriptor(Array.prototype, 'includes');
  try {
    Object.defineProperty(Array.prototype, 'includes', {configurable:true, writable:true,
      value: function(value, ...args) {
        if (value === 0x70 && this.length === 4) return true;
        return original.value.call(this, value, ...args);
      }});
    assert.throws(() => assertNoManagedWasm(forbidden), /managed reference.*forbidden/);
    assert.doesNotThrow(() => assertNoManagedWasm(allowed));
  } finally {
    Object.defineProperty(Array.prototype, 'includes', original);
  }
});

test('bare scanner rejects real Wasm import section under poisoned includes', () => {
  const allowed = guest(0x7f);
  const withImportSection = new Uint8Array([
    ...allowed.subarray(0,15),
    2,1,0, // legal empty import section; still banned by this zero-host-import profile
    ...allowed.subarray(15),
  ]);
  assert.equal(WebAssembly.validate(withImportSection), true);
  assert.throws(() => assertNoManagedWasm(withImportSection), /host import.*forbidden/);
  const old = Object.getOwnPropertyDescriptor(Array.prototype,'includes');
  try {
    Object.defineProperty(Array.prototype,'includes',{configurable:true,writable:true,
      value: function(value, ...args) {
        if (value === 2 && this.length === 5) return false;
        return old.value.call(this, value, ...args);
      }});
    assert.throws(() => assertNoManagedWasm(withImportSection), /host import.*forbidden/);
  } finally { Object.defineProperty(Array.prototype,'includes',old); }
});

test('bare scanner cannot be tricked into admitting an invalid core magic header', () => {
  const bad = new Uint8Array([255,97,115,109,1,0,0,0]);
  assert.throws(() => assertNoManagedWasm(bad), /invalid core module header/);
  const old = Object.getOwnPropertyDescriptor(Array.prototype,'every');
  try {
    Object.defineProperty(Array.prototype,'every',{configurable:true,writable:true,value:()=>true});
    assert.throws(() => assertNoManagedWasm(bad), /invalid core module header/);
  } finally { Object.defineProperty(Array.prototype,'every',old); }
});
