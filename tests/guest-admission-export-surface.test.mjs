import test from 'node:test';
import assert from 'node:assert/strict';
import {compileAdmittedCoreGuest} from '../src/guest-admission.mjs';

// These are genuine, validator-accepted zero-import Wasm modules with one
// bounded memory and a () -> i64 main, not synthetic export arrays.
const utf8 = new TextEncoder();
const name = s => [utf8.encode(s).length, ...utf8.encode(s)];
const section = (id, content) => [id, content.length, ...content];
function guest(visibility, extraExport = false) {
  const custom = section(0, [...name('atto.exports.v1'), 1, ...name('main'), 2, visibility]);
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

test('guest export admission ignores poisoned Array.some and filter', () => {
  const privateEntry = guest(2);
  const publicEntry = guest(1);
  const extraExport = guest(1, true);
  assert.throws(() => compileAdmittedCoreGuest(privateEntry), /EXPORT_PACKAGE_ENTRY_PUBLIC/);
  assert.equal(compileAdmittedCoreGuest(publicEntry).admission.entry, 'main');
  assert.throws(() => compileAdmittedCoreGuest(extraExport), /unexpected guest exports: leak/);
  const oldSome = Object.getOwnPropertyDescriptor(Array.prototype, 'some');
  const oldFilter = Object.getOwnPropertyDescriptor(Array.prototype, 'filter');
  let privateError, extraError, validAdmission;
  try {
    Object.defineProperty(Array.prototype, 'some', {configurable:true, value:function(predicate) {
      if (this.length && this[0].visibility) return false;
      return oldSome.value.call(this, predicate);
    }});
    Object.defineProperty(Array.prototype, 'filter', {configurable:true, value:function() { return []; }});
    try { compileAdmittedCoreGuest(privateEntry); } catch (e) { privateError = e; }
    try { compileAdmittedCoreGuest(extraExport); } catch (e) { extraError = e; }
    validAdmission = compileAdmittedCoreGuest(publicEntry).admission;
  } finally {
    Object.defineProperty(Array.prototype, 'some', oldSome);
    Object.defineProperty(Array.prototype, 'filter', oldFilter);
  }
  assert.match(String(privateError), /EXPORT_PACKAGE_ENTRY_PUBLIC/);
  assert.match(String(extraError), /unexpected guest exports: leak/);
  assert.equal(validAdmission.entry, 'main');
});
