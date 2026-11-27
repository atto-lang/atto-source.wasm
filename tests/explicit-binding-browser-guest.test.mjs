import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
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
  await verifyCompilerBytes(bytes,digest,bytes.length);
  const compiler=await createCompiler(bytes);
  for(const name of ['counter','descending','compound']){
    const source=await fixture(name);
    const result=compiler.compile(source,'wasm','explicit-rebinding');
    assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
    const module=new WebAssembly.Module(result.wasm);
    assert.deepEqual(WebAssembly.Module.imports(module),[]);
    assert.equal(new WebAssembly.Instance(module,{}).exports.main(),42n,name);
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
