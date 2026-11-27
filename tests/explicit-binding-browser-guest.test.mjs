import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isAbsolute,join} from 'node:path';
import {createCompiler,verifyCompilerBytes} from '../src/canonical-browser-compiler.mjs';

const path=process.env.ATTO_EXPLICIT_BROWSER_COMPILER;
const digest=process.env.ATTO_EXPLICIT_BROWSER_COMPILER_SHA256;
const fixture=name=>readFile(new URL('../contracts/explicit-binding-preview/'+name+'.atto',import.meta.url),'utf8');

test('explicit binding browser compiler and actual emitted Wasm guests',async t=>{
  if(!path&&!digest&&process.env.ATTO_REQUIRE_EXPLICIT_BROWSER!=='1') {
    t.skip('NOT_EXECUTED: exact compiler not configured'); return;
  }
  assert.ok(path&&isAbsolute(path),'absolute exact compiler artifact required; no skipped evidence in qualification');
  assert.match(digest??'',/^[a-f0-9]{64}$/);
  const bytes=await readFile(path);
  const expectedSize=process.env.ATTO_EXPLICIT_BROWSER_COMPILER_LENGTH;
  if(process.env.ATTO_REQUIRE_EXPLICIT_BROWSER==='1'){
    assert.match(expectedSize??'',/^[1-9][0-9]*$/,'exact compiler length required');
    assert.ok(isAbsolute(process.env.ATTO_EXPLICIT_NATIVE_GUEST_DIR??''),'native comparison directory required');
  }
  await verifyCompilerBytes(bytes,digest,expectedSize===undefined?bytes.length:Number(expectedSize));
  await assert.rejects(()=>verifyCompilerBytes(bytes,digest,bytes.length+1),/size/);
  const wrongDigest=(digest[0]==='0'?'1':'0')+digest.slice(1);
  await assert.rejects(()=>verifyCompilerBytes(bytes,wrongDigest,bytes.length),/sha256/);
  const compiler=await createCompiler(bytes);
  for(const name of ['counter','descending','compound']){
    const source=await fixture(name);
    const result=compiler.compile(source,'wasm','explicit-rebinding');
    assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
    const module=new WebAssembly.Module(result.wasm);
    assert.deepEqual(WebAssembly.Module.imports(module),[]);
    assert.equal(new WebAssembly.Instance(module,{}).exports.main(),42n,name);
    const repeated=compiler.compile(source,'wasm','explicit-rebinding');
    assert.equal(repeated.ok,true,JSON.stringify(repeated.diagnostics));
    assert.deepEqual(repeated.wasm,result.wasm,'repeat compilation must preserve emitted bytes');
    if(process.env.ATTO_EXPLICIT_NATIVE_GUEST_DIR){
      const native=await readFile(join(process.env.ATTO_EXPLICIT_NATIVE_GUEST_DIR,name+'.wasm'));
      assert.deepEqual(result.wasm,new Uint8Array(native),'native and browser compiler output parity: '+name);
    }
    console.log('EXPLICIT_BINDING_BROWSER_GUEST_PASS',name,createHash('sha256').update(result.wasm).digest('hex'));
  }
  for(const [name,code] of [['bare','E_EXPLICIT_REBIND'],['bare-counter','E_EXPLICIT_REBIND'],['fixed','E_IMMUTABLE']]){
    const result=compiler.compile(await fixture(name),'wasm','explicit-rebinding');
    assert.equal(result.ok,false,name);
    assert.ok(result.diagnostics.some(d=>d.message.includes(code)),JSON.stringify(result));
    assert.equal('wasm' in result,false);
    assert.equal('esm' in result,false);
  }
  // Errors must clear results; a subsequent valid compile must still work.
  assert.equal(compiler.compile(await fixture('counter'),'wasm','explicit-rebinding').ok,true);
  for(const [source,diagnostic] of [
    ['pub fnc main(): int { set missing++; return 42; }','E_UNBOUND'],
    ['pub fnc main(): int { let x = 40; x += 2; return x; }','E_EXPLICIT_REBIND'],
  ]){
    const result=compiler.compile(source,'wasm','explicit-rebinding');
    assert.equal(result.ok,false,source);
    assert.ok(result.diagnostics.some(d=>d.message.includes(diagnostic)),JSON.stringify(result));
    assert.equal('wasm' in result,false);
  }
  const ordinary=compiler.compile(await fixture('bare'));
  assert.equal(ordinary.ok,true,'legacy profile must not be silently changed');
  assert.throws(()=>compiler.compile('pub fnc main(): int { return 42; }','javascript','explicit-rebinding'),/E_EXPLICIT_REBIND_UNSUPPORTED/);
});

test('legacy compiler cannot silently satisfy the explicit profile',async()=>{
  const legacy=await readFile(new URL('../test-support/canonical-compiler.wasm',import.meta.url));
  const instance=new WebAssembly.Instance(new WebAssembly.Module(legacy),{});
  if(typeof instance.exports.compile_explicit_rebinding==='function')throw Error('legacy fixture unexpectedly changed');
  const compiler=await createCompiler(legacy);
  assert.throws(()=>compiler.compile('pub fnc main(): int { return 42; }','wasm','explicit-rebinding'),/E_EXPLICIT_REBIND_UNSUPPORTED/);
});
