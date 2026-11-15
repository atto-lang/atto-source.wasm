import test from 'node:test';
import assert from 'node:assert/strict';
import {readDeclarativeExports, listPublicDeclarativeExports} from '../src/declarative-exports.mjs';

function moduleFromManifest(payload) {
  const name = [...new TextEncoder().encode('atto.exports.v1')];
  const section = [name.length, ...name, ...payload];
  const bytes = Uint8Array.from([0,97,115,109,1,0,0,0,0,section.length,...section]);
  assert.equal(WebAssembly.validate(bytes),true);
  return new WebAssembly.Module(bytes);
}

test('mutated TextDecoder and typed array methods cannot launder invalid UTF-8 names', () => {
  const invalid = moduleFromManifest([1,1,0xff,2,1]);
  const canonical = moduleFromManifest([1,3,70,111,111,2,1]);
  const packagePrivate = moduleFromManifest([1,3,66,97,114,2,2]);
  const decoderDescriptor = Object.getOwnPropertyDescriptor(TextDecoder.prototype,'decode');
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
  const subarrayDescriptor = Object.getOwnPropertyDescriptor(typedArrayPrototype,'subarray');
  assert.throws(() => readDeclarativeExports(invalid), TypeError);
  let result;
  try {
    Object.defineProperty(TextDecoder.prototype,'decode',{configurable:true,writable:true,value(){return 'Foo'}});
    Object.defineProperty(typedArrayPrototype,'subarray',{configurable:true,writable:true,value(){return Uint8Array.from([70,111,111])}});
    result = {
      rejects: assert.throws(() => readDeclarativeExports(invalid), TypeError),
      canonical: readDeclarativeExports(canonical),
      privateNames: listPublicDeclarativeExports(packagePrivate),
    };
  } finally {
    Object.defineProperty(TextDecoder.prototype,'decode',decoderDescriptor);
    Object.defineProperty(typedArrayPrototype,'subarray',subarrayDescriptor);
  }
  assert.deepEqual(result.canonical,[{name:'Foo',kind:'fnc',visibility:'public'}]);
  assert.deepEqual(result.privateNames,[]);
});
