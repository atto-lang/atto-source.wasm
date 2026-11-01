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
 ['missing compiler','ENOENT: compiler not found'],
 ['missing clang','command failed (clang): invalid wasm object'],
 ['missing digest','compiler binary SHA-256 does not match pinned hash'],
 ['timeout','command failed (/tmp/compiler-exact): timed out'],
 ['silent nonzero','command failed (/tmp/compiler-exact): exit 1'],
 ['spawn failure','command failed (/tmp/compiler-exact): spawn EACCES'],
 ['loader issue','command failed (/tmp/compiler-exact): Permission denied'],
 ['ambiguous message','command failed (/tmp/compiler-exact): failure'],
 ['missing file','command failed (/tmp/compiler-exact): no such file'],
 ['non-Error',null]
]){
 test('not semantic proof '+label,()=>assert.equal(semanticCompilerRejection(s===null?s:new Error(s)),false));
}
