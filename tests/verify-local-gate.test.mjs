import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const script = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/verify-wasm-pr-exact.sh');
const exec=(cwd,cmd,args)=>{
 const env={...process.env}; delete env.NODE_TEST_CONTEXT;
 return spawnSync(cmd,args,{cwd,env,encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
};
function fixture({pass=true,summary=true}={}){
 const dir=mkdtempSync(join(tmpdir(),'ores-wasm-gate-test-'));
 mkdirSync(join(dir,'scripts'));
 copyFileSync(script,join(dir,'scripts/verify-wasm-pr-exact.sh'));
 const run = !summary ? 'node -e "console.log(\'synthetic output\')"' : 'node --test test-fixture.mjs';
 writeFileSync(join(dir,'package.json'),JSON.stringify({private:true,scripts:{test:run}}));
 writeFileSync(join(dir,'test-fixture.mjs'),pass?
  'import test from "node:test"; test("passes",()=>{});\n':
  'import test from "node:test"; test("fails",()=>{throw Error("intentional")});\n');
 assert.equal(exec(dir,'git',['init','-q']).status,0);
 assert.equal(exec(dir,'git',['add','.']).status,0);
 assert.equal(exec(dir,'git',['-c','user.name=Verifier','-c','user.email=verifier@example.invalid','commit','-qm','fixture']).status,0);
 const head=exec(dir,'git',['rev-parse','HEAD']).stdout.trim();
 const tree=exec(dir,'git',['rev-parse','HEAD^{tree}']).stdout.trim();
 return {dir,head,tree};
}
for(const [name,mutate,expected] of [
 ['good source, real TAP test summary',()=>{},0],
 ['wrong commit',a=>a.head='0'.repeat(40),65],
 ['wrong root tree',a=>a.tree='f'.repeat(40),65],
 ['dirty source tree',a=>writeFileSync(join(a.dir,'dirty'),'changed'),65],
 ['missing pinned real compiler/AOT identities',a=>a.mode='--require-real',69],
]){
 test('source-local verifier: '+name,()=>{
  const item=fixture();
  try{
   mutate(item);
   const result=exec(item.dir,'bash',[join(item.dir,'scripts/verify-wasm-pr-exact.sh'),item.head,item.tree,item.mode||'--node-only']);
   assert.equal(result.status,expected,result.stdout+'\n'+result.stderr);
  }finally{rmSync(item.dir,{recursive:true,force:true})}
 });
}
for(const [name,setup] of [
 ['rejects missing TAP summary',{summary:false}],
 ['rejects actual Node test failure',{pass:false}],
]){
 test('source-local verifier: '+name,()=>{
  const item=fixture(setup);
  try{
   const r=exec(item.dir,'bash',[join(item.dir,'scripts/verify-wasm-pr-exact.sh'),item.head,item.tree,'--node-only']);
   assert.equal(r.status,1,r.stdout+'\n'+r.stderr);
  }finally{rmSync(item.dir,{recursive:true,force:true})}
 });
}
