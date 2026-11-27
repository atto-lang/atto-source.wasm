// Required delegated proof, not an independent Wasm compiler or a vendor refresh.
// Run only with locally available, authorized exact Rust and conformance checkouts.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,lstat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute,join} from 'node:path';
import {createHash} from 'node:crypto';
import {runBounded} from './named-recursive-browser-worker.mjs';

const compilerHead='020e3e8dd50bd168ec74b66baeb2d00e32dee33d';
const compilerTree='5f5e638ecbe4c06f0350d6c48df3e273b4048bc5';
const fixtureHead='d9b6f797f69759ddbf4e54e916398c20d0d8c955';
const fixtureTree='d1cdd5e4628c562e60d1c05dc343b24fd092cc54';
const fixtureRoot='fixtures/named-recursive-fnc-v1';
const pins=[
  ['fib-0','74c186d5447406cd77469423f64e586645d2017d',{kind:'value',value:'0'}],
  ['fib-1','8c5b03e745c18f08a10d0ca27b39502369cb132b',{kind:'value',value:'1'}],
  ['fib-10','60b65a868d5f8bfda05d2fbaddf01ac319147fd2',{kind:'value',value:'55'}],
  ['fib-10-explicit-semicolon','0369c7b6f95df2334227b9740f0757cdd01ca0cc',{kind:'value',value:'55'}],
  ['fib-55-exact','ab60c8c4ad9726a526a4b0aa9ba76c0acca50b9d',{kind:'compile'}],
  ['fib-name-does-not-escape','2d225a567238b1a38731d2d80083bc1f4942d9ef',{kind:'reject',code:'E_UNBOUND',line:9}]
];
const git=(root,...args)=>execFileSync('git',['-C',root,...args],{
  encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024
}).trimEnd();
function exact(root,head,tree){
  assert.ok(root&&isAbsolute(root),'authorized absolute source checkout required');
  assert.equal(git(root,'rev-parse','HEAD'),head);
  assert.equal(git(root,'rev-parse','HEAD^{tree}'),tree);
  assert.equal(git(root,'status','--porcelain','--untracked-files=all'),'');
}
const source=process.env.ATTO_BROWSER_SOURCE_ROOT;
const fixture=process.env.ATTO_RECURSIVE_FIXTURE_ROOT;
exact(source,compilerHead,compilerTree);
exact(fixture,fixtureHead,fixtureTree);
const cases=pins.map(([id,blob,expected])=>{
  const path=fixtureRoot+'/'+id+'.atto';
  assert.equal(git(fixture,'rev-parse',fixtureHead+':'+path),blob,id);
  const bytes=execFileSync('git',['-C',fixture,'show',fixtureHead+':'+path],{timeout:10000,maxBuffer:65536});
  assert.equal(execFileSync('git',['hash-object','--stdin'],{input:bytes,encoding:'utf8'}).trim(),blob,id);
  return {id,source:new TextDecoder('utf-8',{fatal:true}).decode(bytes),expected};
});
const count=n=>'pub fnc main(): int {return '+n+' |> fnc count(int v): int {^ match v over on 0 -> 0, on _ -> count(v-1)+1 end;};}';
cases.push(
  {id:'depth-1024',source:count(1024),expected:{kind:'value',value:'1024'}},
  {id:'depth-1025',source:count(1025),expected:{kind:'panic',code:6}},
  {id:'overflow',source:'pub fnc main(): int {return 9223372036854775807 |> fnc f(int v): int {return v+1;};}',expected:{kind:'panic',code:1}}
);
const work=await mkdtemp(join(tmpdir(),'atto-browser-recursion-'));
try{
  const checkout=join(work,'source'),target=join(work,'target');
  execFileSync('git',['init','--quiet',checkout],{timeout:10000});
  // Local Git transport only. No network clone, cross-org checkout or tokens.
  execFileSync('git',['-C',checkout,'-c','protocol.file.allow=always','fetch','--no-tags','--depth=1',source,compilerHead],{timeout:120000,stdio:'inherit'});
  execFileSync('git',['-C',checkout,'-c','core.hooksPath=/dev/null','checkout','--detach',compilerHead],{timeout:120000,stdio:'inherit'});
  exact(checkout,compilerHead,compilerTree);
  // This is a fresh tracked checkout, not a caller-supplied compiler binary.
  const inventory=git(checkout,'ls-tree','-r','HEAD');
  assert.ok(!/^(120000|160000) /m.test(inventory),'symlink or submodule requires separate review');
  const toolchain=execFileSync('rustc',['--version'],{cwd:checkout,encoding:'utf8',timeout:10000}).trim();
  execFileSync('cargo',['build','--locked','--offline','--release','--lib','--target','wasm32-unknown-unknown','--target-dir',target],{
    cwd:checkout,timeout:300000,stdio:'inherit'
  });
  const path=join(target,'wasm32-unknown-unknown','release','atto_compiler.wasm');
  const stat=await lstat(path);
  assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>8&&stat.size<=8*1024*1024);
  const compilerBytes=await readFile(path);
  assert.equal(compilerBytes.length,stat.size);
  const digest=createHash('sha256').update(compilerBytes).digest('hex');
  const results=await runBounded({kind:'compiler',compilerBytes,cases},60000);
  assert.equal(results.length,cases.length);
  exact(checkout,compilerHead,compilerTree);
  exact(source,compilerHead,compilerTree);
  exact(fixture,fixtureHead,fixtureTree);
  console.log('NAMED_RECURSIVE_BROWSER_RECEIPT',JSON.stringify({
    profile:'delegated-rust-browser-direct-stage',compilerHead,compilerTree,fixtureHead,fixtureTree,
    compilerSha256:digest,compilerBytes:compilerBytes.length,toolchain,results,
    notExecuted:['fib-55-exact-runtime','fib-55-linear','fib-92-linear','fib-93-overflow'],
    independentWasm:false
  }));
}finally{await rm(work,{recursive:true,force:true});}
