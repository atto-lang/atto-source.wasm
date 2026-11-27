// HOST-ONLY diagnostic classifier controls, not native Wasm guest execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {assertPinnedCompilerSha256,semanticCompilerRejection} from '../src/oresllm-compiler-evidence.mjs';
const good='a'.repeat(64);
test('canonical 64-char lowercase compiler binary pin accepted',()=>{
 assert.equal(assertPinnedCompilerSha256(good),good);
});
for(const [label,v] of [
 ['unset',undefined],['blank',''],['uppercase','A'.repeat(64)],
 ['short','a'.repeat(63)],['long','a'.repeat(65)],
 ['path','/tmp/compiler-exact'],['nonhex','z'.repeat(64)],
 ['number',64]
]){
 test('compiler pin reject '+label,()=>assert.throws(()=>assertPinnedCompilerSha256(v),/compiler SHA-256 pin/));
}
for(const [label,s] of [
 ['unexpected syntax','command failed (/tmp/compiler-exact): unexpected token'],
 ['invalid operator','command failed (/tmp/compiler-exact): invalid operator at byte 15'],
 ['missing identifier','command failed (/tmp/compiler-exact): unbound identifier'],
 ['unsupported division','command failed (/tmp/compiler-exact): division requires float lowering']
]){
 test('semantic compiler reject '+label,()=>assert.equal(semanticCompilerRejection(new Error(s)),true));
}
for(const [label,s] of [
 ['native async modifier','command failed (/tmp/compiler-exact): legacy async modifier forbidden; use suspends'],
 ['native critical-suspends','command failed (/tmp/compiler-exact): critical suspends modifier combination forbidden'],
 ['native suspends-critical','command failed (/tmp/compiler-exact): suspends critical fnc modifier is disallowed']
]){
 test('native effect diagnostic stays compiler-owned '+label,()=>{
   assert.equal(semanticCompilerRejection(new Error(s)),true);
 });
}
for(const s of [
 'command failed (clang): async modifier forbidden',
 'command failed (/tmp/compiler-exact): async modifier forbidden\\nspawn EACCES',
 'command failed (/tmp/compiler-exact): critical suspends modifier forbidden\\nout of memory',
 'command failed (/tmp/compiler-exact): async modifier forbidden\\nexit 124'
]){
 test('effect diagnostic cannot launder infrastructure failure '+s.slice(0,36),()=>{
   assert.equal(semanticCompilerRejection(new Error(s)),false);
 });
}
test('real multiline native compiler syntax diagnostics remain semantic rejects',()=>{
 assert.equal(semanticCompilerRejection(new Error(
   'command failed (/tmp/compiler-exact): invalid token at byte 13\n' +
   '  at parser line 1\n')),true);
});
test('late-line infrastructure failure cannot be laundered by first-line syntax',()=>{
 assert.equal(semanticCompilerRejection(new Error(
   'command failed (/tmp/compiler-exact): invalid token\\n' +
   'spawn EACCES on nested helper')),false);
});
for(const [label,s] of [
 ['missing compiler','ENOENT: compiler not found'],
 ['missing clang','command failed (clang): invalid wasm object'],
 ['missing digest','compiler binary SHA-256 does not match pinned hash'],
 ['timeout','command failed (/tmp/compiler-exact): timed out'],
 ['missing file after parser error','command failed (/tmp/compiler-exact): invalid token\nNo such file or directory'],
 ['segfault after parser error','command failed (/tmp/compiler-exact): unknown variable\nSegmentation fault'],
 ['signal after parser error','command failed (/tmp/compiler-exact): unexpected expression\nkilled by signal'],
 ['resource exhaustion','command failed (/tmp/compiler-exact): expected name\nout of memory'],
 ['digest error after syntax','command failed (/tmp/compiler-exact): syntax error\nSHA-256 mismatch'],
 ['timeout exit status','command failed (/tmp/compiler-exact): unknown token\nexit 124'],
 ['silent nonzero','command failed (/tmp/compiler-exact): exit 1'],
 ['spawn failure','command failed (/tmp/compiler-exact): spawn EACCES'],
 ['loader issue','command failed (/tmp/compiler-exact): Permission denied'],
 ['ambiguous message','command failed (/tmp/compiler-exact): failure'],
 ['missing file','command failed (/tmp/compiler-exact): no such file'],
 ['non-Error',null]
]){
 test('not semantic proof '+label,()=>assert.equal(semanticCompilerRejection(s===null?s:new Error(s)),false));
}

test('typed arithmetic bool denial from compiler-exact is semantic',()=>{
 const diagnostic='oreslang-llvmc: arithmetic requires int, got bool at byte 34 [file: source.atto]';
 assert.equal(semanticCompilerRejection(new Error('command failed (/tmp/compiler-exact): '+diagnostic)),true);
 for(const s of [
  'command failed (clang): '+diagnostic,
  'command failed (/tmp/compiler-exact): '+diagnostic+'\nspawn EACCES',
  'command failed (/tmp/compiler-exact): '+diagnostic+'\nexit 124',
  'command failed (/tmp/compiler-exact): arithmetic requires int, got bool',
  'command failed (/tmp/compiler-exact): '+diagnostic+'\ntransport failure'
 ]) {
  assert.equal(semanticCompilerRejection(new Error(s)),false,s);
 }
});

test('serialized diagnostic with escaped line separators is not raw stderr',()=>{
 assert.equal(semanticCompilerRejection(new Error('command failed (/tmp/compiler-exact): invalid token\\n  at parser line 1')),false);
});
test('actual multiline effect diagnostics cannot hide infrastructure failure',()=>{
 for(const tail of ['spawn EACCES','out of memory','exit 124']) {
  assert.equal(semanticCompilerRejection(new Error('command failed (/tmp/compiler-exact): async modifier forbidden\n'+tail)),false);
 }
});
