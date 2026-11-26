import test from 'node:test';
import assert from 'node:assert/strict';
import {assertScalarSourceHasNoImports} from '../scripts/compile-ores.mjs';
import {invalidSourceUtf16Offset,sourceNameEnd} from '../src/source-unicode-identifiers.mjs';
const enc = s => new TextEncoder().encode(s);

test('keyword boundaries retain whole Unicode identifiers', () => {
  for (const name of ['importΦ','import𠮷','数量import','import〇','Φimport','變數']) {
    assert.equal(sourceNameEnd(name,0), name.length);
    assert.doesNotThrow(() => assertScalarSourceHasNoImports(enc('pub fnc main(): int { val '+name+' = 42; return '+name+'; }')));
  }
  for (const s of ['import namespace x from "x";','// comment\u0085import x;','// comment\rimport x;']) {
    assert.throws(() => assertScalarSourceHasNoImports(enc(s)), /imports require/);
  }
});

test('malformed UTF-16 cannot be silently replaced before compilation', () => {
  assert.equal(invalidSourceUtf16Offset('Φ𠮷¬'),-1);
  for (const s of ['\ud800','\udc00','x\ud800y','x\udc00']) {
    assert.equal(invalidSourceUtf16Offset(s),s.startsWith('x')?1:0);
  }
});
