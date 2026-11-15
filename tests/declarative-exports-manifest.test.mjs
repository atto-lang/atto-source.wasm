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

test('rejects noncanonical count and name varints, overflow and truncation', () => {
  const cases = [
    [[0x80, 0], 'EXPORT_MANIFEST_VARINT_NONCANONICAL'],
    [[0x81, 0, ...entry('Foo', 1, 1)], 'EXPORT_MANIFEST_VARINT_NONCANONICAL'],
    [[1, 0x81, 0, 65, 1, 1], 'EXPORT_MANIFEST_VARINT_NONCANONICAL'],
    [[1, 0x80, 0x80, 0, 65, 1, 1], 'EXPORT_MANIFEST_VARINT_NONCANONICAL'],
    [[0xff, 0xff, 0xff, 0xff, 0x10], 'EXPORT_MANIFEST_VARINT_OVERFLOW'],
    [[0xff, 0xff, 0xff, 0xff, 0x00], 'EXPORT_MANIFEST_VARINT_NONCANONICAL'],
    [[0x81, 0x80, 0x80, 0x80, 0x80, 0], 'EXPORT_MANIFEST_VARINT_OVERFLOW']
  ];
  for (const [bytes, diagnostic] of cases)
    assert.throws(() => readDeclarativeExports(wasm(bytes)), new RegExp(diagnostic));
});

test('bounds manifest size and admits the maximal canonical 1024-entry payload', () => {
  assert.throws(
    () => readDeclarativeExports(wasm([0, ...new Array(266243).fill(0)])),
    /EXPORT_MANIFEST_SECTION_TOO_LARGE/);
  const maximum = [
    ...uleb(1024),
    ...Array.from({length: 1024}, (_, i) =>
      entry('x'.repeat(250) + i.toString().padStart(6, '0'), 1, 1)).flat()
  ];
  assert.equal(readDeclarativeExports(wasm(maximum)).length, 1024);
});

test('rejects repeated same-name sections even when their contents agree', () => {
  const sectionName = name('atto.exports.v1');
  const body = [...sectionName, 0];
  const section = [0, ...uleb(body.length), ...body];
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, ...section, ...section]);
  assert.equal(WebAssembly.validate(bytes), true);
  const module = new WebAssembly.Module(bytes);
  assert.throws(() => readDeclarativeExports(module), /EXPORT_MANIFEST_DUPLICATE_SECTION/);
});

test('rejects malformed text, identifiers, count budgets and trailing bytes', () => {
  const cases = [
    [[1, 1, 0xff, 1, 1], TypeError],
    [[1, ...entry('1bad', 1, 1)], /EXPORT_MANIFEST_NAME/],
    [[...uleb(1025)], /EXPORT_MANIFEST_COUNT/],
    [[0, 0x55], /EXPORT_MANIFEST_TRAILING_BYTES/],
    [[0x80], /EXPORT_MANIFEST_TRUNCATED/]
  ];
  for (const [bytes, error] of cases)
    assert.throws(() => readDeclarativeExports(wasm(bytes)), error);
  const empty = new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));
  assert.deepEqual(readDeclarativeExports(empty), []);
});
