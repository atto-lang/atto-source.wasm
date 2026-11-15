import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAdmittedCoreGuest } from '../src/guest-admission.mjs';
import { readDeclarativeExports, listPublicDeclarativeExports } from '../src/declarative-exports.mjs';

// Genuine Wasm core modules, not host-only mock export descriptors.
// Public main is callable; package-private helper is metadata, not authority.
const utf8 = new TextEncoder();
const name = value => [utf8.encode(value).length, ...utf8.encode(value)];
const section = (id, bytes) => [id, bytes.length, ...bytes];
function moduleBytes(leakPrivateHelper) {
  const custom = section(0, [
    ...name('atto.exports.v1'), 2,
    ...name('main'), 2, 1,
    ...name('helper'), 2, 2
  ]);
  const type = section(1, [1, 0x60, 0, 1, 0x7e]);
  const fn = section(3, [1, 0]);
  const memory = section(5, [1, 1, 1, 2]);
  const exported = section(7, [
    leakPrivateHelper ? 3 : 2,
    ...name('main'), 0, 0,
    ...name('memory'), 2, 0,
    ...(leakPrivateHelper ? [...name('helper'), 0, 0] : [])
  ]);
  const code = section(10, [1, 4, 0, 0x42, 42, 0x0b]);
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0,
    ...custom, ...type, ...fn, ...memory, ...exported, ...code]);
  assert.equal(WebAssembly.validate(bytes), true);
  return bytes;
}

test('public guest entrypoint coexists with private declarative helper', () => {
  const bytes = moduleBytes(false);
  const compiled = compileAdmittedCoreGuest(bytes);
  assert.equal(compiled.admission.entry, 'main');
  const declared = readDeclarativeExports(new WebAssembly.Module(bytes));
  assert.equal(declared.length, 2);
  assert.deepEqual(listPublicDeclarativeExports(new WebAssembly.Module(bytes)), [
    { name:'main', kind:'fnc', visibility:'public' }
  ]);
});

test('exported private helper is refused at the actual guest admission boundary', () => {
  assert.throws(() => compileAdmittedCoreGuest(moduleBytes(true)),
    /unexpected guest exports: helper/);
});
