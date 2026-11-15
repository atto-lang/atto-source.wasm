import test from 'node:test';
import assert from 'node:assert/strict';
import {readDeclarativeExports, listPublicDeclarativeExports} from '../src/declarative-exports.mjs';

const encode = new TextEncoder();
const name = s => [encode.encode(s).length, ...encode.encode(s)];
function moduleWithEntry(kind, visibility) {
  const body = [...name('atto.exports.v1'), 1, ...name('Foo'), kind, visibility];
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 0, body.length, ...body]);
  assert.equal(WebAssembly.validate(bytes), true);
  return new WebAssembly.Module(bytes);
}

test('trusted Wasm custom-section admission cannot be erased by mutable static methods', () => {
  const privateModule = moduleWithEntry(2, 2);
  const invalidModule = moduleWithEntry(8, 1);
  const publicModule = moduleWithEntry(2, 1);
  const ctorDescriptor = Object.getOwnPropertyDescriptor(WebAssembly, 'Module');
  const customSectionsDescriptor = Object.getOwnPropertyDescriptor(WebAssembly.Module, 'customSections');
  try {
    Object.defineProperty(WebAssembly.Module, 'customSections', {
      configurable: true,
      writable: true,
      value: () => []
    });
    // Even swapping the visible constructor must not invalidate a real module.
    Object.defineProperty(WebAssembly, 'Module', {
      configurable: true,
      writable: true,
      value: class FakeModule {}
    });
    assert.deepEqual(readDeclarativeExports(privateModule),
      [{name:'Foo', kind:'fnc', visibility:'package'}]);
    assert.deepEqual(listPublicDeclarativeExports(privateModule), []);
    assert.throws(() => readDeclarativeExports(invalidModule), /EXPORT_MANIFEST_ENUM/);
    assert.deepEqual(listPublicDeclarativeExports(publicModule),
      [{name:'Foo', kind:'fnc', visibility:'public'}]);
  } finally {
    Object.defineProperty(WebAssembly, 'Module', ctorDescriptor);
    Object.defineProperty(WebAssembly.Module, 'customSections', customSectionsDescriptor);
  }
});
