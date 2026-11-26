import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const tool=fileURLToPath(new URL('../scripts/verify-exception-bang-wasm.mjs',import.meta.url));
const sha=x=>createHash('sha256').update(x).digest('hex');
const minimal=Buffer.from([0,97,115,109,1,0,0,0]); // valid empty wasm, no compiler ABI
function fixture(fn){
  const dir=mkdtempSync(join(tmpdir(),'atto-bang-wasm-'));
  try{
    const path=join(dir,'compiler.wasm');writeFileSync(path,minimal);
    return fn(path);
  }finally{rmSync(dir,{recursive:true,force:true});}
}
function rejected(args,pattern){
  const r=spawnSync(process.execPath,[tool,...args],{
    encoding:'utf8',timeout:10_000,maxBuffer:1024*1024});
  assert.equal(r.error,undefined);
  assert.notEqual(r.status,0,'an unverified compiler must never qualify');
  assert.match(r.stderr+'\n'+r.stdout,pattern);
}
test('unconfigured compiler artifact cannot pass',()=>{
  rejected([],/Usage: .*approved-compiler/);
});
test('malformed digest and arbitrary artifact paths reject before execution',()=>{
  fixture(path=>rejected([path,'wrong'],/Usage:/));
});
test('tampered compiler digest fails closed',()=>{
  fixture(path=>rejected([path,'0'.repeat(64)],/unapproved or altered compiler binary/));
});
test('a valid Wasm binary without compiler ABI is insufficient',()=>{
  fixture(path=>rejected([path,sha(minimal)],/missing compiler ABI/));
});
