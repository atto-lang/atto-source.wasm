import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {isAbsolute} from 'node:path';
import {createCompiler,verifyCompilerBytes} from '../src/canonical-browser-compiler.mjs';

// Fresh wasm32 compiler, not the older vendored artifact. The browser adapter
// is exercised end-to-end for both generated guest targets.
const head='37908fbe096c7780ce211b7996e03e9d09396d7d';
const tree='62abf6108aab4a48fb46a037db11ad50a652897d';
const required=process.env.ATTO_SET_BROWSER_REQUIRED==='1';
test('authenticated browser compiler bounded Set guest and rejection recovery',{skip:!required},async()=>{
  const root=process.env.ATTO_BROWSER_SOURCE_ROOT,file=process.env.ATTO_BROWSER_COMPILER;
  assert.ok(root&&isAbsolute(root)&&file&&isAbsolute(file));
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:10000}).trim();
  assert.equal(git('rev-parse','HEAD'),head);
  assert.equal(git('rev-parse','HEAD^{tree}'),tree);
  assert.equal(git('write-tree'),tree);
  assert.equal(git('status','--porcelain','--untracked-files=no'),'');
  const bytes=await readFile(file),digest=process.env.ATTO_BROWSER_COMPILER_SHA256;
  assert.match(digest??'',/^[a-f0-9]{64}$/);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),digest);
  await verifyCompilerBytes(bytes,digest,bytes.length);
  const compiler=await createCompiler(bytes);
  const cases=[
    ['fnc main(): int { let s = Set.of(7, 7, 42); return s.len(); }',2n],
    ['fnc main(): int { let n = -7; let s = Set.of(n, n + 49, n); return s.contains(42) ? 42 : 0; }',42n],
    ['fnc main(): int { let s = Set.of(-9223372036854775808, 9223372036854775807, -9223372036854775808); return s.len(); }',2n],
    ['fnc main(): int { let s = Set.of(0, -1); return s.contains(42) ? 1 : 42; }',42n],
    ['fnc main(): int { let s = Set.of(1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16); let n = s.len(); let present = s.contains(16); return present ? n : 0; }',16n],
  ];
  async function execute(source,target,want){
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
    for(let i=0;i<2;i++){
      assert.equal(guest.main(),want);
      assert.equal(guest.panic_code.value,0);
    }
  }
  for(const [source,want] of cases){
    for(const target of ['wasm','javascript']) await execute(source,target,want);
  }
  const negative=[
    'fnc main(): int { let s = Set.of(1); let alias = s; return alias.len(); }',
    'fnc main(): int { let s = Set.of(1, true); return s.len(); }',
    'fnc main(): int { let s = Set.of(1); let t = Set.of(2); return s.len(); }',
    'fnc main(): int { let s = Set.of(1); s.add(2); return s.len(); }',
    'fnc main(): int { let s = Set.of(1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17); return s.len(); }',
  ];
  for(const bad of negative){
    for(const target of ['wasm','javascript']){
      const r=compiler.compile(bad,target);
      assert.equal(r.ok,false,bad);
      assert.ok(r.diagnostics.length);
      assert.equal('wasm' in r,false);
      assert.equal('esm' in r,false);
      await execute(cases[0][0],target,cases[0][1]);
    }
  }
  console.log('SET_BROWSER_RECEIPT',JSON.stringify({head,tree,digest,positive:10,reject:10,recovery:10,repeat:true,byteIdentity:true}));
});
