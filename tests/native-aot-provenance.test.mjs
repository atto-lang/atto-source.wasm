import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {gitBlobSha,verifyNativeAotProvenance} from '../ci/native-aot/verify-provenance.mjs';
const paths=[
  'aot-host/profile.rs','aot-host/io.rs',
  'aot-host/precompile/Cargo.lock','aot-host/precompile/Cargo.toml',
  'aot-host/precompile/src/main.rs','aot-host/precompile/src/publish.rs',
  'aot-host/precompile/src/wasm_admission.rs',
  'aot-host/run/Cargo.lock','aot-host/run/Cargo.toml',
  'aot-host/run/build.rs','aot-host/run/src/main.rs',
  'aot-host/run/src/tenant_isolation.rs'
];
function fixture(fn){
  const dir=mkdtempSync(join(tmpdir(),'atto-provenance-'));
  const current_source_blobs={},source_blobs={};
  try{
    for(const [i,p] of paths.entries()){
      const data=Buffer.from('native source '+i+'\n');
      mkdirSync(dirname(join(dir,p)),{recursive:true});writeFileSync(join(dir,p),data);
      current_source_blobs[p]=gitBlobSha(data);source_blobs[p]=gitBlobSha(data);
    }
    source_blobs[paths[6]]='b'.repeat(40);
    const manifest={schema:'atto.source-wasm-seeded-native-aot-prototype.v1',
      origin:{commit:'a'.repeat(40)},current_snapshot:{base_commit:'c'.repeat(40)},
      current_source_blobs,source_blobs};
    fn({dir,manifest});
  }finally{rmSync(dir,{recursive:true,force:true});}
}
test('12 physical exact blobs, tracked historical replacements',()=>fixture(({dir,manifest})=>{
  const out=verifyNativeAotProvenance(dir,manifest);
  assert.deepEqual([out.current_blobs_verified,out.historic_seed_replacements],[12,1]);
  assert.equal(gitBlobSha(Buffer.from('hello')),'b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0');
}));
test('mutated current Rust source fails closed',()=>fixture(({dir,manifest})=>{
  writeFileSync(join(dir,paths[6]),'malicious substitute');
  assert.throws(()=>verifyNativeAotProvenance(dir,manifest),/current source mismatch/);
}));
test('invalid or missing seed sha cannot pass historical audit',()=>fixture(({dir,manifest})=>{
  delete manifest.source_blobs[paths[4]];
  assert.throws(()=>verifyNativeAotProvenance(dir,manifest),/invalid manifest/);
}));
test('unexpected extra current path is rejected',()=>fixture(({dir,manifest})=>{
  manifest.current_source_blobs['aot-host/extra.rs']='a'.repeat(40);
  assert.throws(()=>verifyNativeAotProvenance(dir,manifest),/invalid manifest/);
}));
test('reject symlinked native source even with matching blob sha',()=>fixture(({dir,manifest})=>{
  const source=join(dir,paths[6]);
  rmSync(source);symlinkSync(join(dir,paths[0]),source);
  manifest.current_source_blobs[paths[6]]=manifest.current_source_blobs[paths[0]];
  assert.throws(()=>verifyNativeAotProvenance(dir,manifest),/symlink native source/);
}));
test('reject malformed origin SHA',()=>fixture(({dir,manifest})=>{
  manifest.origin.commit='not-an-immutable-sha';
  assert.throws(()=>verifyNativeAotProvenance(dir,manifest),/invalid manifest/);
}));
