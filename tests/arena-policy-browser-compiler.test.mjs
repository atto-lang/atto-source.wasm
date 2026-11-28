import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createCompiler,verifyCompilerBytes} from '../src/canonical-browser-compiler.mjs';
import {arenaPolicyBatches} from './arena-policy-differential-v1.mjs';
const head='8ef911ab903037699c5d6b047afb180799daa37d';
const required=process.env.ATTO_ARENA_BROWSER_REQUIRED==='1';
test('real browser compiler emits policy Wasm and ESM guests',{skip:!required},async()=>{
 const root=process.env.ATTO_BROWSER_SOURCE_ROOT,file=process.env.ATTO_BROWSER_COMPILER;
 assert.ok(root&&file);
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:10000}).trim();
 assert.equal(git('rev-parse','HEAD'),head);
 assert.equal(git('write-tree'),git('rev-parse','HEAD^{tree}'));
 assert.equal(git('status','--porcelain','--untracked-files=no'),'');
 const bytes=readFileSync(file),digest=process.env.ATTO_BROWSER_COMPILER_SHA256;
 assert.match(digest??'',/^[0-9a-f]{64}$/);
 assert.equal(createHash('sha256').update(bytes).digest('hex'),digest);
 await verifyCompilerBytes(bytes,digest,bytes.length);
 const compiler=await createCompiler(bytes);
 const pinned=(path,sha)=>{
  const b=readFileSync(new URL('../'+path,import.meta.url));
  assert.equal(createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex'),sha,path);
  return b.toString('utf8');
 };
 pinned('tests/arena-policy-differential-v1.mjs','f98055af7bb9b8952664946d2b2a1f3a735dc283');
 const core=pinned('stdlib/policy/core/arena_limits.atto','5928e893a2ce1baadb0376a4ccb14f63249f77d4');
 const life=pinned('stdlib/policy/alloc/arena_lifecycle.atto','e4795c6d4bd561be3d913cdc617d103d0e2828c8');
 const fixed=pinned('tests/fixtures/arena-quota-lifecycle-guest.atto','2b1eb28f07b792f2727abe9a5691849f024e304a');
 const run=async(source,target,want)=>{
  const r=compiler.compile(source,target);
  assert.equal(r.ok,true,JSON.stringify(r.diagnostics));
  const repeat=compiler.compile(source,target);
  assert.equal(repeat.ok,true);
  let guest;
  if(target==='wasm'){
   assert.deepEqual(repeat.wasm,r.wasm);
   const mod=new WebAssembly.Module(r.wasm);
   assert.deepEqual(WebAssembly.Module.imports(mod),[]);
   guest=new WebAssembly.Instance(mod,{}).exports;
  }else{
   assert.equal(repeat.esm,r.esm);
   guest=(await import('data:text/javascript;base64,'+Buffer.from(r.esm).toString('base64'))).instantiate().exports;
  }
  assert.equal(guest.main(),want,target);
  assert.equal(guest.panic_code.value,0);
 };
 const mask=pinned('tests/fixtures/arena-policy-rust-mask-v1.atto','96d14731780b041d92ff518ca9c6c125bcd3d4c7');
 const original=core+'\n'+life+'\n'+fixed;
 const prefix=mask+'\n'+life+'\n',marker='arena_end_offset(0, 0, 1, 0) != 0';
 assert.equal(fixed.split(marker).length,2);
 for(const target of ['wasm','javascript']){
  const denied=compiler.compile(original,target);
  assert.equal(denied.ok,false,'original division policy must not be silently lowered');
  assert.match(JSON.stringify(denied.diagnostics),/checked integer division/);
  assert.equal('wasm' in denied,false);assert.equal('esm' in denied,false);
  await run(prefix+fixed,target,100n);
  await run(prefix+fixed.replace(marker,'arena_end_offset(0, 0, 1, 0) != 1'),target,1n);
  let count=0;
  for(const batch of arenaPolicyBatches()){
   await run(prefix+batch.source,target,100n);count+=batch.count;
  }
  assert.equal(count,352);
  console.log('ARENA_BROWSER_POLICY_PASS target='+target+' profile=rust-mask assertions=408 wrong_oracle=1 original_division_denied=1 compiler='+digest);
 }
});
