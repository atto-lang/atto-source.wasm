import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const PIN='752d1ad3fb3564eed9067a0a530eb2150d1c14b4';
const mode=process.env.ATTO_U64_GENERATED_WASM_REQUIRED;
assert.ok(mode===undefined||mode==='0'||mode==='1','ATTO_U64_GENERATED_WASM_REQUIRED must be 0 or 1');
const path=process.env.ATTO_U64_LLVM_SOURCE;
const blob=b=>createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
// Same deterministic source corpus as JS #230 (cbaa344006d453fb043126303d50d64fff6daa28).
const MAX=(1n<<64n)-1n;
const M=0xffffffffn;
let state=0x9e3779b97f4a7c15n;
function next(){state^=(state<<13n)&MAX;state^=state>>7n;state^=(state<<17n)&MAX;return state;}
const checked=n=>n<0n||n>MAX?null:n;
const cases=[];
for(let i=0;i<256;i++){
  const a=next(),b=next(),c=next();
  const x=a&M,y=b&M;
  cases.push({family:'add',expr:`op(${a},${i%2===0?MAX-a:b})`,op:'+',expected:checked(a+(i%2===0?MAX-a:b))});
  cases.push({family:'subtract',expr:`op(${a},${i%2===0?a:b})`,op:'-',expected:checked(a-(i%2===0?a:b))});
  cases.push({family:'multiply',expr:`op(${i%2===0?x:a},${i%2===0?y:b})`,op:'*',expected:checked((i%2===0?x:a)*(i%2===0?y:b))});
  const p=checked(x*y),q=checked(p+c);
  cases.push({family:'intermediate',expr:`first(42,op(${x},${y})+${c})`,op:'*',expected:q===null?null:42n});
}
const familyFilter=process.env.ATTO_U64_WASM_FAMILY;
const families=['add','subtract','multiply','intermediate'];
assert.ok(familyFilter===undefined||families.includes(familyFilter),'invalid generated Wasm family');
const selected=familyFilter===undefined?families:[familyFilter];
test('exact delegated LLVM Wasm generated guest corpus',{timeout:300000,skip:!path&&mode!=='1'?'NOT_EXECUTED: exact LLVM compiler source unavailable':false},async t=>{
  assert.ok(path,'ATTO_U64_LLVM_SOURCE required');const bytes=readFileSync(resolve(path));assert.equal(blob(bytes),PIN);
  const root=mkdtempSync(join(tmpdir(),'atto-generated-wasm-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const cpp=join(root,'frontend.cpp'),compiler=join(root,'frontend');writeFileSync(cpp,bytes);
  const run=(cmd,args,input)=>{const r=spawnSync(cmd,args,{cwd:root,input,timeout:30000,maxBuffer:1024*1024});assert.ifError(r.error);assert.equal(r.signal,null);assert.equal(r.status,0,r.stderr.toString());return r.stdout;};
  run(process.env.CLANGXX??'clang++',['-std=c++20','-O2','-Wall','-Wextra','-Werror',cpp,'-o',compiler]);
  let total=0;
  for(const family of selected)await t.test(family,async()=>{
    const output=join(root,'guest.wasm');let values=0,faults=0;
    for(const [i,row] of cases.filter(x=>x.family===family).entries()){
      const source=`pub fnc main():uint{return ${row.expr};} fnc op(u64 a,uint b):u64{return a${row.op}b;} fnc first(uint a,u64 b):uint{return a;}`;
      const ir=run(compiler,['--emit=llvm'],source);
      run(process.env.CLANG??'clang',['--target=wasm32-unknown-unknown','-Wno-override-module',i%2===0?'-O0':'-O2','-nostdlib','-Wl,--no-entry','-Wl,--export=atto_guest_main','-x','ir','-','-o',output],ir);
      const {instance}=await WebAssembly.instantiate(readFileSync(output));const main=instance.exports.atto_guest_main;
      assert.equal(typeof main,'function');
      if(row.expected===null){assert.throws(()=>main(),WebAssembly.RuntimeError,`${family} ${i}`);faults++;}
      else{assert.equal(BigInt.asUintN(64,main()),row.expected,`${family} ${i}`);values++;}
    }
    assert.equal(values+faults,256);assert.ok(values>0&&faults>0);console.log(`${family}: ${values} values, ${faults} expected faults`);total+=values+faults;
  });
  assert.equal(total,256*selected.length);assert.equal(blob(readFileSync(resolve(path))),PIN);
});
