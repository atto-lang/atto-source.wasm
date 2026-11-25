import {fixed_memory_pages} from '../src/wasm-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';

const verifier = fileURLToPath(new URL('../scripts/verify-linked-package-wasm.mjs', import.meta.url));
const root = fileURLToPath(new URL('./fixtures/linked-package-v1/', import.meta.url));
const blobs = [
  ['.atto.pkg.toml','4177f0f46272526a45fb9db775efa71814f4657b'],
  ['src/main.atto','22d252e703502488407c948f0f3f84cc1d91d36a'],
  ['lib/orders.atto','868403fab2f8d3524bf0cf54799bca6d80e89b43'],
  ['lib/math.atto','525585c4eb34a4572b7041cf72d658c66fd045cc']
];
const sha = b => createHash('sha256').update(b).digest('hex');
const gitBlob = b => createHash('sha1').update('blob ' + b.length + '\0').update(b).digest('hex');
function invoke(args) {
  const r=spawnSync(process.execPath,[verifier,...args],{
    encoding:'utf8',timeout:10000,maxBuffer:1024*1024
  });
  assert.equal(r.error,undefined,'verifier must finish without timeout');
  assert.notEqual(r.status,0,'missing or untrusted compiler cannot count as guest pass');
  return r.stdout + '\n' + r.stderr;
}

test('four complete source units retain their independently pinned Git blobs',()=>{
  for(const [path,pin] of blobs){
    const actual=readFileSync(join(root,path));
    assert.equal(gitBlob(actual),pin,path);
  }
  assert.match(readFileSync(join(root,'src/main.atto'),'utf8'),/\+lib\/orders\.atto/);
  assert.match(readFileSync(join(root,'lib/orders.atto'),'utf8'),/\.\/math\.atto/);
  assert.match(readFileSync(join(root,'lib/math.atto'),'utf8'),/fnc secret/);
});

test('no compiler or malformed compiler SHA fails closed',()=>{
  assert.match(invoke([]),/Usage:/);
  assert.match(invoke(['/bin/missing','not-a-hash']),/Usage:/);
  assert.match(invoke(['relative/attoc','0'.repeat(64)]),/Usage:/);
});

test('nonmatching real file bytes reject before any source graph compilation',()=>{
  const dir=mkdtempSync(join(tmpdir(),'atto-linked-gate-negative-'));
  try{
    const binary=join(dir,'fake-attoc');
    writeFileSync(binary,'not a compiler');
    assert.match(invoke([binary,'0'.repeat(64)]),/compiler binary SHA-256 mismatch/);
    // Even a perfectly pinned artifact is not an approval or guest result.
    assert.match(invoke([binary,sha(Buffer.from('not a compiler'))]),
      /failed to spawn reviewed compiler/);
  }finally{
    rmSync(dir,{recursive:true,force:true});
  }
});

// Rust wasm.rs emits no memory for scalar-only/inline-task source.
// A present memory must be fixed; growth/oversize is denied.
test('scalar-only guests may omit memory, while present memories remain bounded',()=>{
  const header=Buffer.from([0,97,115,109,1,0,0,0]);
  assert.equal(fixed_memory_pages(header),0,'no memory is a valid scalar guest');
  assert.equal(fixed_memory_pages(Buffer.concat([header,Buffer.from([5,4,1,1,1,1])])),1);
  assert.throws(()=>fixed_memory_pages(Buffer.concat([header,Buffer.from([5,3,1,0,1])])),/E_WASM_MEMORY/);
  assert.throws(()=>fixed_memory_pages(Buffer.concat([header,Buffer.from([5,4,1,1,1,17])])),/E_WASM_MEMORY/);
});
