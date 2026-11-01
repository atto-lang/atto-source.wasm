// HOST-ONLY security tests; never counts as compiler-backed Wasm execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,mkdtempSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateCompiler,compilerOwnedDenial} from '../scripts/run-client-scalar-native.mjs';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const script=join(root,'scripts/run-client-scalar-native.mjs');
const digests=new Map([
 ['01-precedence.ores','e42464360ffa360b263bc74f74ef485e6a9e4eb9dff601ead2c4576982622576'],
 ['02-grouping.ores','9196a61de9c4710bdf32e658de396c521ad2abb2e3d03ce711ae449ac7aa5a2f'],
 ['03-signed.ores','613d1e1e104361ce555f397dd0d23754d44ade5b80750147110c1e4a73cce286'],
 ['04-i64-edge.ores','b0f80c76a24cb15ed25fee0bdaa096d7cbcd318f787f7d8a040166c127532247'],
 ['05-separators.ores','2bcfdc119d3e48b9ac97e2061b7b88571d6e621b04ecabf886347d9eeb19382c'],
 ['06-nested.ores','dd1bf333cdd17140571227e810427030a279666b8a4d06eb5968a056cf5a8a2a'],
 ['07-unknown-reject.ores','c45493f0814253ab5a2e8896d8b39643c7b8e1247d408eef11baccd79d6580e1'],
 ['08-overflow-reject.ores','37b793a36e231ee37d953b8359cd0f004dc008a795eb32a413762a0a504c542c'],
 ['09-syntax-reject.ores','32f4b30c52ce58955ecbb0aa0d564f0ac394737940faaab01351e25ed9df4b75']
]);
test('nine source SHA-256s are identical to the public client scalar fixtures',()=>{
 assert.equal(digests.size,9);
 for(const [file,expected] of digests){
  const body=readFileSync(join(root,'tests/fixtures/clients-scalar-v1',file));
  assert.equal(createHash('sha256').update(body).digest('hex'),expected,file);
 }
});
test('native Wasm runner must never succeed without a real pinned compiler',()=>{
 const v=spawnSync(process.execPath,[script],{encoding:'utf8',timeout:5000,maxBuffer:16384,
   env:{PATH:'/usr/bin:/bin',HOME:tmpdir(),LANG:'C'}});
 assert.equal(v.status,1);
 assert.match(v.stderr,/Wasm scalar parity blocked/);
 assert.doesNotMatch(v.stdout,/WASM_CLIENT_SCALAR_6_GUEST_RESULTS/);
});
test('compiler admission rejects relative, unpinned and spoofed executable bytes',()=>{
 assert.throws(()=>validateCompiler('relative','a'.repeat(64)));
 assert.throws(()=>validateCompiler('/not-existing-binary','a'.repeat(64)));
 const tmp=mkdtempSync(join(tmpdir(),'wasm-client-admission-'));
 try{
  const executable=join(tmp,'compiler');
  const link=join(tmp,'alias');
  writeFileSync(executable,Buffer.from('not an Oreslang compiler'));
  symlinkSync(executable,link);
  assert.throws(()=>validateCompiler(executable,'0'.repeat(64)),/wrong SHA-256/);
  assert.throws(()=>validateCompiler(link,'0'.repeat(64)),/regular file/);
 }finally{rmSync(tmp,{recursive:true,force:true})}
});

test('compiler-owned negative diagnostic cannot be spoofed by source path or Clang failure',()=>{
 const category=/unknown|unbound|undefined|identifier/i;
 assert.equal(compilerOwnedDenial('Error: command failed (/tmp/xx/compiler-exact): unbound or unsupported identifier: value',category),true);
 assert.equal(compilerOwnedDenial('Error: command failed (clang): unknown argument --target=wasm32',category),false);
 assert.equal(compilerOwnedDenial('Error: ENOENT /tmp/07-unknown-reject.ores',category),false);
 assert.equal(compilerOwnedDenial('Error: command failed (/tmp/xx/compiler-exact): cannot open /tmp/07-unknown-reject.ores',category),false);
 assert.equal(compilerOwnedDenial('Error: command failed (/tmp/xx/compiler-exact): unbound identifier\nstack backtrace',category),false);
 assert.equal(compilerOwnedDenial('Error: command failed (/tmp/xx/compiler-exact): internal compiler error: unknown thing',category),false);
});
