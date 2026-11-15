import test from 'node:test';
import assert from 'node:assert/strict';
import {readDeclarativeExports, listPublicDeclarativeExports} from '../src/declarative-exports.mjs';

// Genuine WebAssembly.Module objects: export metadata lives in custom-section
// bytes returned by the native API, not in caller-provided JavaScript objects.
function moduleFromManifest(contents) {
  const sectionName = [...new TextEncoder().encode('atto.exports.v1')];
  const section = [sectionName.length, ...sectionName, ...contents];
  const bytes = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, 0, section.length, ...section]);
  assert.equal(WebAssembly.validate(bytes), true);
  return new WebAssembly.Module(bytes);
}

test('a replaced global Uint8Array cannot forge public export visibility', () => {
  const privateModule = moduleFromManifest([1, 3, 70, 111, 111, 2, 2]);
  const malformedModule = moduleFromManifest([1, 3, 70, 111, 111, 2, 3]);
  const publicModule = moduleFromManifest([1, 3, 70, 111, 111, 2, 1]);
  assert.deepEqual(listPublicDeclarativeExports(privateModule), []);
  assert.throws(() => readDeclarativeExports(malformedModule), /EXPORT_MANIFEST_ENUM/);

  const original = Object.getOwnPropertyDescriptor(globalThis, 'Uint8Array');
  const NativeUint8Array = Uint8Array;
  let privateNames, malformedError, publicNames;
  try {
    // An actor sharing the realm replaces the global AFTER this decoder module
    // was imported. The forged constructor preserves ArrayBuffer semantics but
    // flips the final visibility byte in each manifest to public (1).
    Object.defineProperty(globalThis, 'Uint8Array', {
      configurable: true, writable: true,
      value: function ForgedUint8Array(source, ...rest) {
        const bytes = new NativeUint8Array(source, ...rest);
        if (source instanceof ArrayBuffer && bytes.length > 0)
          bytes[bytes.length - 1] = 1;
        return bytes;
      }
    });
    privateNames = listPublicDeclarativeExports(privateModule);
    try { readDeclarativeExports(malformedModule); } catch (e) { malformedError = e; }
    publicNames = listPublicDeclarativeExports(publicModule);
  } finally {
    Object.defineProperty(globalThis, 'Uint8Array', original);
  }
  assert.deepEqual(privateNames, []);
  assert.match(String(malformedError), /EXPORT_MANIFEST_ENUM/);
  assert.deepEqual(publicNames, [{name: 'Foo', kind: 'fnc', visibility: 'public'}]);
});


test('a replaced RegExp.test cannot admit noncanonical export names', () => {
  const malformedModule = moduleFromManifest([1, 4, 70, 111, 111, 45, 2, 1]);
  assert.throws(() => readDeclarativeExports(malformedModule), /EXPORT_MANIFEST_NAME/);
  const original = Object.getOwnPropertyDescriptor(RegExp.prototype, 'test');
  let malformedError;
  try {
    Object.defineProperty(RegExp.prototype, 'test', {
      configurable: true, writable: true, value() { return true; }
    });
    try { readDeclarativeExports(malformedModule); } catch (e) { malformedError = e; }
  } finally {
    Object.defineProperty(RegExp.prototype, 'test', original);
  }
  assert.match(String(malformedError), /EXPORT_MANIFEST_NAME/);
});

test('a forged Uint8Array species cannot rewrite a declared export name', () => {
  const canonicalModule = moduleFromManifest([1, 3, 70, 111, 111, 2, 1]);
  assert.equal(readDeclarativeExports(canonicalModule)[0].name, 'Foo');
  const original = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'constructor');
  const NativeUint8Array = Uint8Array;
  let decoded;
  try {
    // TypedArray.prototype.subarray invokes the species constructor of its
    // receiver, even when the native subarray function was captured earlier.
    Object.defineProperty(Uint8Array.prototype, 'constructor', {
      configurable: true, writable: true,
      value: {[Symbol.species]: function ForgedNameView() {
        return NativeUint8Array.from([66, 97, 114]); // Bar, not Foo
      }}
    });
    decoded = readDeclarativeExports(canonicalModule);
  } finally {
    Object.defineProperty(Uint8Array.prototype, 'constructor', original);
  }
  assert.equal(decoded[0].name, 'Foo');
});
