import test from 'node:test';
import assert from 'node:assert/strict';
import {TextDecoder as NodeTextDecoder} from 'node:util';
import {assertScalarSourceHasNoImports as rejectImport} from '../scripts/compile-ores.mjs';
const enc = new TextEncoder();
const check = source => rejectImport(enc.encode(source));

test('rejects import in executable source and after NEL line-comment boundary',()=>{
  for(const source of [
    'import +lib/unsafe;',
    '// comment\u0085import +lib/unsafe;',
    '// comment\nimport +lib/unsafe;',
    '// comment\rimport +lib/unsafe;',
    '// comment\u2028import +lib/unsafe;',
    '// comment\u2029import +lib/unsafe;',
    '/* nested /* comment */ */import +lib/unsafe;'
  ]) assert.throws(()=>check(source),/imports require verified complete Wasm module graph/,JSON.stringify(source));
});

test('inert import words inside comments and literals stay inert',()=>{
  for(const source of [
    '// import +ignored\nfnc main():int{return 42;}',
    '/* import +ignored /* nested import +ignored */ */ fnc main():int{return 42;}',
    '"import +ignored"; fnc main():int{return 42;}',
    "'import +ignored'; fnc main():int{return 42;}",
    '`import +ignored`; fnc main():int{return 42;}',
    'let imported = 2;'
  ]) assert.doesNotThrow(()=>check(source),JSON.stringify(source));
});

test('post-import decoder and regex tampering cannot hide an import',()=>{
  const original=globalThis.TextDecoder,native=NodeTextDecoder.prototype.decode,regex=RegExp.prototype.test;
  let outcome;
  globalThis.TextDecoder=class{decode(){return 'fnc main():int{return 42;}' }};
  NodeTextDecoder.prototype.decode=()=> 'fnc main():int{return 42;}';
  RegExp.prototype.test=()=>false;
  try {check('import +sensitive/path;')} catch(error){outcome=error;}
  finally {globalThis.TextDecoder=original;NodeTextDecoder.prototype.decode=native;RegExp.prototype.test=regex;}
  assert.match(outcome?.message??'',/imports require verified complete Wasm module graph/);
});

test('post-import String and Array prototype tampering cannot hide import',()=>{
  const sl=String.prototype.slice,inx=String.prototype.indexOf,inc=Array.prototype.includes, strinc=String.prototype.includes;
  let outcome;
  String.prototype.slice=()=> 'safe';
  String.prototype.indexOf=()=> -1;
  String.prototype.includes=()=>false;
  Array.prototype.includes=()=>false;
  try {check('// NEL boundary\u0085import +private/path;')} catch(error){outcome=error;}
  finally {String.prototype.slice=sl;String.prototype.indexOf=inx;String.prototype.includes=strinc;Array.prototype.includes=inc;}
  assert.match(outcome?.message??'',/imports require verified complete Wasm module graph/);
});

test('rejects NUL and malformed UTF-8 and tolerates NEL trivia',()=>{
  assert.throws(()=>check('fnc main():int{return 1;}\u0000'),/NUL byte/);
  assert.throws(()=>rejectImport(Uint8Array.from([0xc3,0x28])),/encoded|valid|UTF/i);
  assert.doesNotThrow(()=>check('// benign\u0085fnc main():int{return 42;}'));
});
