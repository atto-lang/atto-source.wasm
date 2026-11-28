import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {isAbsolute,join} from 'node:path';
import {createCompiler,verifyCompilerBytes} from '../src/canonical-browser-compiler.mjs';

// This repository delegates compilation to an authenticated wasm32 Rust
// compiler. No independent frontend or vendored artifact refresh is claimed.
const head='456b2186ce22a9b56fb7bf99c3f3e20c1024e7d4';
const tree='b31da72167eccaa58c2e7c837b9af01e7b7d908d';
const required=process.env.ATTO_BAE_BROWSER_REQUIRED==='1';
const pass=['borrow-getter-elision-v1-layout','borrow-int-pair-v1','borrow-formal-forward-v1','borrow-two-args-v1','borrow-method-getter-v1','borrow-many-args-v1'];
test('authenticated browser compiler BAE guests and rejection recovery',{skip:!required},async()=>{
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
  async function fixture(path){return readFile(join(root,'tests/fixtures',path+'.atto'),'utf8');}
  function compile(source){
    const r=compiler.compile(source);
    assert.equal(r.ok,true,JSON.stringify(r.diagnostics));
    const mod=new WebAssembly.Module(r.wasm);
    assert.deepEqual(WebAssembly.Module.imports(mod),[]);
    const guest=new WebAssembly.Instance(mod,{});
    return {r,guest};
  }
  for(const name of pass){
    const source=await fixture('pass/'+name);
    const {r,guest}=compile(source);
    assert.equal(guest.exports.main(),42n,name);
    assert.equal(guest.exports.panic_code.value,0,name);
    assert.deepEqual(compile(source).r.wasm,r.wasm,'deterministic output '+name);
  }
  const source=await fixture('pass/borrow-method-getter-v1');
  const direct=source.replace('return inspect(parcel);','return parcel.value;');
  assert.notEqual(source,direct);
  assert.deepEqual(compile(source).r.wasm,compile(direct).r.wasm,'transitive getter call eliminated');
  const overflow=compile(await fixture('panic/borrow-int-pair-v1-overflow')).guest;
  assert.throws(()=>overflow.exports.main(),WebAssembly.RuntimeError);
  assert.equal(overflow.exports.panic_code.value,1);
  const negative=[
    source.replace('return p.get();','return p.missing;'),
    source.replace('return p.get();','return p;'),
    source.replace('return p.get();','let q = p; return q.get();')
  ];
  for(const bad of negative){
    const r=compiler.compile(bad);
    assert.equal(r.ok,false,bad);assert.ok(r.diagnostics.length);
    assert.equal('wasm' in r,false);
    assert.equal(compile(source).guest.exports.main(),42n);
  }
  console.log('BAE_BROWSER_RECEIPT',JSON.stringify({head,tree,digest,positive:pass.length,overflow:1,reject:negative.length,recovery:negative.length,byteIdentity:true}));
});
