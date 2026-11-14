import test from 'node:test';
import assert from 'node:assert/strict';
import {readDeclarativeExports, listPublicDeclarativeExports} from '../src/declarative-exports.mjs';

// This test validates genuine Wasm custom-section decoding, not guest .atto
// source compilation or package linking. Those require a verified compiler.
const utf8 = new TextEncoder();
const uleb = (n) => {
  const out = [];
  do { let b = n & 127; n = Math.floor(n / 128); if (n) b |= 128; out.push(b); } while (n);
  return out;
};
const name = (s) => { const b = [...utf8.encode(s)]; return [...uleb(b.length), ...b]; };
function wasm(sectionContents) {
  const sectionName = name('atto.exports.v1');
  const section = [...sectionName, ...sectionContents];
  const binary = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 0, ...uleb(section.length), ...section]);
  assert.equal(WebAssembly.validate(binary), true);
  return new WebAssembly.Module(binary);
}
const entry = (s, kind, visibility) => [...name(s), kind, visibility];

test('reads public and package class/fnc exports from actual Wasm custom section', () => {
  const module = wasm([3, ...entry('Bar', 1, 2), ...entry('Foo', 1, 1), ...entry('calculate', 2, 1)]);
  const decoded = readDeclarativeExports(module);
  assert.deepEqual(decoded, [
    {name:'Bar',kind:'class',visibility:'package'},
    {name:'Foo',kind:'class',visibility:'public'},
    {name:'calculate',kind:'fnc',visibility:'public'}
  ]);
  assert.deepEqual(listPublicDeclarativeExports(module), decoded.slice(1));
  assert.ok(Object.isFrozen(decoded));
  assert.ok(Object.isFrozen(decoded[0]));
});

test('rejects malformed export metadata and duplicates', () => {
  const cases = [
    [2, ...entry('Foo', 1, 1), ...entry('Foo', 1, 2)],
    [1, ...entry('Bar', 1, 3)],
    [1, ...entry('Bar', 8, 1)],
    [1, 4, 65], 
    [0, 1],
    [255, 255, 127],
  ];
  for (const contents of cases) {
    assert.throws(() => readDeclarativeExports(wasm(contents)), TypeError);
  }
});

test('manifest reader never accepts arbitrary bytes as an authorized package', () => {
  assert.throws(() => readDeclarativeExports(new Uint8Array([0,97,115,109])), TypeError);
});
