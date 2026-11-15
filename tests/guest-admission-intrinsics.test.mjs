import test from 'node:test';
import assert from 'node:assert/strict';
import {compileAdmittedCoreGuest} from '../src/guest-admission.mjs';

// Genuine, engine-validated Wasm bytes. In repository CI the admission
// pipeline uses the real snapshot, memory-policy and ABI validation modules.
const utf8 = new TextEncoder();
const name = s => [utf8.encode(s).length, ...utf8.encode(s)];
const section = (id, content) => [id, content.length, ...content];
function guest(extraExport = false) {
  const custom = section(0, [...name('atto.exports.v1'), 1, ...name('main'), 2, 1]);
  const types = section(1, [1, 0x60, 0, 1, 0x7e]);
  const functions = section(3, [1, 0]);
  const memory = section(5, [1, 1, 1, 2]);
  const exports = section(7, [extraExport ? 3 : 2,
    ...name('main'), 0, 0, ...name('memory'), 2, 0,
    ...(extraExport ? [...name('leak'), 0, 0] : [])]);
  const code = section(10, [1, 4, 0, 0x42, 42, 0x0b]);
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0,
    ...custom, ...types, ...functions, ...memory, ...exports, ...code]);
  assert.equal(WebAssembly.validate(bytes), true);
  return bytes;
}

test('guest admission cannot lose extra exports under patched WebAssembly.Module.exports', () => {
  const withLeak = guest(true);
  const plain = guest();
  assert.throws(() => compileAdmittedCoreGuest(withLeak), /unexpected guest exports: leak/);
  assert.equal(compileAdmittedCoreGuest(plain).admission.entry, 'main');
  const original = Object.getOwnPropertyDescriptor(WebAssembly.Module, 'exports');
  try {
    Object.defineProperty(WebAssembly.Module, 'exports', { configurable: true, writable: true,
      value: () => [{name:'main',kind:'function'}, {name:'memory',kind:'memory'}] });
    assert.throws(() => compileAdmittedCoreGuest(withLeak), /unexpected guest exports: leak/);
    assert.equal(compileAdmittedCoreGuest(plain).admission.entry, 'main');
  } finally {
    Object.defineProperty(WebAssembly.Module, 'exports', original);
  }
});
