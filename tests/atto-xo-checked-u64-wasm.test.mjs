import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const corpusUrl = new URL('../contracts/atto-xo-checked-u64-debit-v1/cases.tsv', import.meta.url);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const expectedSourceBlob = '752d1ad3fb3564eed9067a0a530eb2150d1c14b4';
const expectedCorpus = '3a79dc1db8ee896fc2b39a4df136c102ebfa341f282b8d16785fb035b663ca58';
const blob = bytes => createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
const inventory = new Map([
  ['normal','3150'],['above-i64','9223372036854775808'],['full-max','18446744073709551615'],
  ['precision-edge','9007199254740993'],['zero-debit','0'],['uint-alias','18446744073709551615'],
  ['product-overflow','overflow'],['fee-overflow','overflow'],['overflow-cancel','overflow'],
  ['overflow-dead-result','overflow'],['unsigned-underflow','overflow'],['consumer-overflow','overflow']
]);
function parse(bytes) {
  assert.equal(digest(bytes),expectedCorpus,'exact corpus SHA-256');
  const rows = new TextDecoder('utf-8',{fatal:true}).decode(bytes).split('\n');
  assert.equal(rows.pop(),''); assert.equal(rows.length,inventory.size);
  const seen = new Set();
  return rows.map(row=>{
    const f=row.split('|'); assert.equal(f.length,9);
    const [id,expected,,,,,,,source]=f;
    assert.ok(inventory.has(id)&&!seen.has(id),id);
    assert.equal(expected,inventory.get(id)); seen.add(id);
    return {id,expected,source};
  });
}
function observe(bytes,expected) {
  const module = new WebAssembly.Module(bytes);
  assert.deepEqual(WebAssembly.Module.imports(module),[],'no host imports');
  assert.deepEqual(WebAssembly.Module.exports(module).filter(x=>x.kind==='function'),[{name:'atto_guest_main',kind:'function'}]);
  const {atto_guest_main:main}=new WebAssembly.Instance(module).exports;
  if(expected==='overflow') assert.throws(()=>main(),WebAssembly.RuntimeError);
  else {
    const value=main(); assert.equal(typeof value,'bigint');
    assert.equal(BigInt.asUintN(64,value).toString(),expected,'full unsigned result');
  }
}
test('exact unsigned guest corpus inventory',()=>{
  const bytes=readFileSync(corpusUrl); assert.equal(parse(bytes).length,12);
  const mutant=Buffer.from(bytes); mutant[0]^=1;
  assert.throws(()=>parse(mutant),/exact corpus SHA-256/);
});
const sourcePath=process.env.ATTO_U64_LLVM_SOURCE;
const required=process.env.ATTO_U64_WASM_REQUIRED==='1';
test('delegated exact LLVM source to freestanding wasm32 guests',{
  skip: !sourcePath&&!required?'NOT_EXECUTED: exact compiler source not configured':false,
  timeout:180000
},()=>{
  assert.ok(sourcePath,'required compiler source missing');
  const bytes=readFileSync(resolve(sourcePath)); assert.equal(blob(bytes),expectedSourceBlob,'compiler source blob mismatch');
  const dir=mkdtempSync(join(tmpdir(),'atto-u64-wasm-'));
  try {
    const compiler=join(dir,'compiler'); const source=join(dir,'compiler.cpp'); writeFileSync(source,bytes);
    function run(cmd,args,input) {
      const r=spawnSync(cmd,args,{input,cwd:dir,encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
      assert.ifError(r.error); assert.equal(r.signal,null); assert.equal(r.status,0,r.stderr); return r.stdout;
    }
    run(process.env.CLANGXX??'clang++',['-std=c++20','-O2','-Wall','-Wextra','-Werror',source,'-o',compiler]);
    const binaryPin=digest(readFileSync(compiler));
    for(const row of parse(readFileSync(corpusUrl))) for(const opt of ['-O0','-O2']) {
      const ir=run(compiler,[],row.source); assert.ok(ir.includes('define i64 @atto_guest_main()'));
      const input=join(dir,'guest.ll'),output=join(dir,'guest.wasm'); writeFileSync(input,ir);
      run(process.env.CLANG??'clang',['--target=wasm32-unknown-unknown','-Wno-override-module',opt,'-nostdlib','-Wl,--no-entry','-Wl,--export=atto_guest_main',input,'-o',output]);
      observe(readFileSync(output),row.expected);
      rmSync(output); rmSync(input);
    }
    assert.equal(digest(readFileSync(compiler)),binaryPin);
    assert.equal(blob(readFileSync(source)),expectedSourceBlob);
    assert.equal(blob(readFileSync(resolve(sourcePath))),expectedSourceBlob);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
