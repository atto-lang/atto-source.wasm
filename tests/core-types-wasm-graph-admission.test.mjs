// Compiler-source admission, NOT compiled Wasm guest evidence.
// Wasm scalar bridge has no authenticated import graph; it MUST reject the
// shared core/types positive fixtures rather than publishing incomplete Wasm.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {assertScalarSourceHasNoImports} from '../scripts/compile-ores.mjs';

const asBytes=s=>new TextEncoder().encode(s);
const core=await readFile(new URL('../core/types.atto',import.meta.url));
const positives=[
  'edge-positive.atto','edge-matrix-positive.atto'
];
test('backend-owned namespace library is not mistaken for a cross-file import',()=>{
  assert.doesNotThrow(()=>assertScalarSourceHasNoImports(core));
});
test('two real imported .atto guests cannot masquerade as standalone wasm32 programs',async()=>{
  for(const fixture of positives){
    const data=await readFile(new URL('./fixtures/core-types-v1/'+fixture,import.meta.url));
    assert.throws(()=>assertScalarSourceHasNoImports(data),
      /source imports require verified complete Wasm module graph/,fixture);
  }
});
test('preflight rejects import syntax after comments, nested comments and mixed newlines',()=>{
  for(const source of [
    '/* outer /* nested */ tail */\rimport * as types from "./types.atto";',
    '// ignored import within comment\rimport * as types from "./types.atto";',
    'use namespace root;\nimport * as types from "./types.atto";',
    '\u2028import fnc f from "./types.atto";'
  ])assert.throws(()=>assertScalarSourceHasNoImports(asBytes(source)),
    /source imports require verified complete Wasm module graph/);
});
test('quoted and commented import text does not create an invisible dependency',()=>{
  for(const source of [
    'use namespace types; // import fnc f from "./types.atto";',
    'use namespace types; /* import fnc f from "./types.atto"; */',
    'use namespace types; /* outer /* import x */ end */',
    'use namespace types; pub fnc important() -> int { return 7; }'
  ])assert.doesNotThrow(()=>assertScalarSourceHasNoImports(asBytes(source)));
});
test('NUL and malformed comments do not silently bypass source admission',()=>{
  assert.throws(()=>assertScalarSourceHasNoImports(asBytes('use namespace t;\0import x;')),/NUL byte/);
  assert.throws(()=>assertScalarSourceHasNoImports(asBytes('/* unterminated import x;')),/unterminated Oreslang block comment/);
});
