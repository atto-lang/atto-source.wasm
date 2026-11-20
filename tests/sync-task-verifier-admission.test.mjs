import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const gate=fileURLToPath(new URL('../scripts/verify-sync-task-wasm.mjs',import.meta.url));
const fixture=fileURLToPath(new URL('./fixtures/sync-task-inline-v1/main.atto',import.meta.url));
const hash=b=>createHash('sha256').update(b).digest('hex');
function rejected(args){
  const r=spawnSync(process.execPath,[gate,...args],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
  assert.equal(r.error,undefined);
  assert.notEqual(r.status,0,'untrusted/missing compiler cannot pass guest evidence');
  return r.stdout+'\n'+r.stderr;
}
test('canonical inline sync task source is pinned and void-only',()=>{
  const data=readFileSync(fixture);
  const blob=createHash('sha1').update('blob '+data.length+String.fromCharCode(0)).update(data).digest('hex');
  assert.equal(blob,'e08cbf7ccc5b0d041897ce215c2c3a1f434f983f');
  const s=data.toString('utf8');
  assert.ok(s.includes('do sync task {};'));
  assert.ok(s.includes('do sync task<void> {};'));
  assert.ok(s.includes('sync task<int> {'));
  assert.ok(!s.includes('do sync task<int>'));
});
test('missing, relative or malformed executable requests fail closed',()=>{
  assert.match(rejected([]),/Usage:/);
  assert.match(rejected(['relative/attoc','0'.repeat(64)]),/Usage:/);
  assert.match(rejected(['/missing/attoc','not-a-sha']),/Usage:/);
});
test('binary pin is checked before test compiler can run',()=>{
  const dir=mkdtempSync(join(tmpdir(),'atto-sync-gate-test-'));
  try {
    const executable=join(dir,'fake-attoc');
    const bytes=Buffer.from('not the reviewed compiler');
    writeFileSync(executable,bytes);
    assert.match(rejected([executable,'0'.repeat(64)]),/reviewed compiler SHA-256 mismatch/);
    assert.match(rejected([executable,hash(bytes)]),/compiler did not start/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
