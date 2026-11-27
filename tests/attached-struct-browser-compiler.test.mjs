import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {isAbsolute,join} from 'node:path';
import {createCompiler,verifyCompilerBytes} from '../src/canonical-browser-compiler.mjs';

// Delegated target proof through the Wasm repository's real browser compiler ABI.
// Does not claim an independent Wasm frontend or a refreshed vendored artifact.
const compilerHead='c2ff8e8369e398eee018db1a1c1f45f27bcda428';
const compilerTree='910e12faf393e3503f5913cfb289066ffa7214c4';
const fixtureHead='c196a575dc5249f57c013013d384ad0b8b02309c';
const fixtureTree='bac51327d3fc9c53afd0c0bead885f3e9c5240ae';
const required=process.env.ATTO_STRUCT_BROWSER_REQUIRED==='1';
function exact(root,head,tree){
  assert.ok(root&&isAbsolute(root),'absolute authorized checkout required');
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:10000}).trim();
  assert.equal(git('rev-parse','HEAD'),head);
  assert.equal(git('rev-parse','HEAD^{tree}'),tree);
  assert.equal(git('status','--porcelain','--untracked-files=no'),'');
}
const decode=new TextDecoder('utf-8',{fatal:true});
function observe(target,result,expected,name){
  let printed='';
  const observer={print_i64:n=>printed+=String(n),print_bool:n=>printed+=String(n),print_newline:()=>printed+='\n'};
  if(target==='wasm'){
    assert.ok(result.wasm instanceof Uint8Array);
    const mod=new WebAssembly.Module(result.wasm);
    for(const row of WebAssembly.Module.imports(mod)){
      assert.equal(row.module,'atto');
      assert.equal(row.kind,'function');
      assert.ok(Object.hasOwn(observer,row.name),row.name);
    }
    return check(new WebAssembly.Instance(mod,{atto:observer}));
  }
  assert.equal(typeof result.esm,'string');
  return import('data:text/javascript;base64,'+Buffer.from(result.esm,'utf8').toString('base64'))
    .then(module=>check(module.instantiate(observer)));
  function check(guest){
    if(expected==='overflow'){
      assert.throws(()=>guest.exports.main(),target==='wasm'?WebAssembly.RuntimeError:/E_PANIC:1/,name);
      assert.equal(guest.exports.panic_code.value,1,name);
    }else{
      assert.equal(guest.exports.main(),BigInt(expected),name);
      assert.equal(guest.exports.panic_code.value,0,name);
    }
    assert.equal(printed,'',name);
  }
}
test('actual browser compiler Wasm and ESM targets execute shared attached-struct corpus',{skip:!required},async()=>{
  exact(process.env.ATTO_BROWSER_SOURCE_ROOT,compilerHead,compilerTree);
  exact(process.env.ATTO_STRUCT_FIXTURE_ROOT,fixtureHead,fixtureTree);
  const file=process.env.ATTO_BROWSER_COMPILER,digest=process.env.ATTO_BROWSER_COMPILER_SHA256;
  assert.ok(file&&isAbsolute(file));assert.match(digest??'',/^[a-f0-9]{64}$/);
  const bytes=await readFile(file);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),digest);
  await verifyCompilerBytes(bytes,digest,bytes.length);
  const root=join(process.env.ATTO_STRUCT_FIXTURE_ROOT,'fixtures/attached-struct-seven-target-v1');
  const rows=decode.decode(await readFile(join(root,'manifest.tsv'))).trim().split('\n').map(l=>l.split('\t'));
  assert.equal(rows.length,15);
  assert.equal(new Set(rows.map(r=>r[0])).size,15);
  assert.deepEqual(rows.map(r=>r[0]).sort(),(await readdir(root)).filter(n=>n.endsWith('.atto')).sort());
  const fixtures=[];
  for(const [name,expected,...rest] of rows){
    assert.equal(rest.length,0);assert.match(name,/^[a-z-]+\.atto$/);
    assert.match(expected,/^(reject|overflow|-?(0|[1-9][0-9]*))$/);
    fixtures.push({name,expected,source:decode.decode(await readFile(join(root,name)))});
  }
  const recovery=fixtures.find(f=>f.name==='nested.atto');assert.equal(recovery.expected,'42');
  // One instance per target, reused across successes, rejection and recovery.
  for(const target of ['wasm','javascript']){
    const compiler=await createCompiler(bytes);
    const receipt={target,positive:0,reject:0,overflow:0,recoveries:0};
    for(const {name,expected,source} of fixtures){
      const r=compiler.compile(source,target);
      if(expected==='reject'){
        assert.equal(r.ok,false,name);assert.ok(r.diagnostics.length,name);
        assert.equal('wasm' in r,false,name);assert.equal('esm' in r,false,name);
        receipt.reject++;
        const next=compiler.compile(recovery.source,target);
        assert.equal(next.ok,true,JSON.stringify(next.diagnostics));
        await observe(target,next,recovery.expected,'recovery after '+name);
        receipt.recoveries++;
      }else{
        assert.equal(r.ok,true,JSON.stringify(r.diagnostics));
        await observe(target,r,expected,name);
        if(expected==='overflow')receipt.overflow++;else receipt.positive++;
      }
    }
    assert.deepEqual(receipt,{target,positive:4,reject:9,overflow:2,recoveries:9});
    console.log('BROWSER_ATTACHED_STRUCT_RECEIPT',JSON.stringify({...receipt,compilerHead,compilerTree,fixtureHead,fixtureTree,digest}));
  }
});
