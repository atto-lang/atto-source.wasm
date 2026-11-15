import test from 'node:test';
import assert from 'node:assert/strict';
import {readDeclarativeExports, listPublicDeclarativeExports} from '../src/declarative-exports.mjs';

// A source-free, deterministic differential check over real validated Wasm
// custom sections; this is not guest .atto compilation or package linking.
const encoder = new TextEncoder();
function uleb(value) {
  const out = [];
  do {
    let byte = value & 127;
    value = Math.floor(value / 128);
    if (value) byte |= 128;
    out.push(byte);
  } while (value);
  return out;
}
function entry(name, kind, visibility) {
  const bytes = [...encoder.encode(name)];
  return [...uleb(bytes.length), ...bytes, kind, visibility];
}
function moduleFromManifest(data) {
  const sectionName = [...encoder.encode('atto.exports.v1')];
  const payload = [...uleb(sectionName.length), ...sectionName, ...data];
  const binary = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0,
    0, ...uleb(payload.length), ...payload]);
  assert.equal(WebAssembly.validate(binary), true);
  return new WebAssembly.Module(binary);
}
let seed = 0x937cf721;
function next() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed;
}
const letter = () => String.fromCharCode(65 + next() % 26);
const kinds = {1:'class', 2:'fnc', 3:'actor', 4:'enum'};
const visibilities = {1:'public', 2:'package'};

test('5000 deterministic valid-Wasm manifests preserve duplicate and visibility admission', () => {
  for (let trial = 0; trial < 5000; trial++) {
    const count = next() % 12;
    const generated = [];
    const bytes = [...uleb(count)];
    for (let j = 0; j < count; j++) {
      let name = letter() + letter() + String(j);
      if (j && next() % 7 === 0)
        name = generated[next() % j].name;
      const kind = 1 + next() % 5;
      const visibility = 1 + next() % 4;
      generated.push({name, kind, visibility});
      bytes.push(...entry(name, kind, visibility));
    }
    const module = moduleFromManifest(bytes);
    const names = generated.map(x => x.name);
    const duplicates = names.length !== new Set(names).size;
    const valid = !duplicates &&
      generated.every(x => x.kind <= 4 && x.visibility <= 2);
    if (!valid) {
      assert.throws(() => readDeclarativeExports(module), TypeError);
      continue;
    }
    const decoded = readDeclarativeExports(module);
    assert.deepEqual(decoded, generated.map(x => ({
      name:x.name, kind:kinds[x.kind], visibility:visibilities[x.visibility]
    })));
    assert.deepEqual(listPublicDeclarativeExports(module),
      decoded.filter(x => x.visibility === 'public'));
  }
});
