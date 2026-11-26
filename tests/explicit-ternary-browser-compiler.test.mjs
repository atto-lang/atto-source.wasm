import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createCompiler,verifyCompilerBytes} from '../src/canonical-browser-compiler.mjs';

// This is an opt-in real browser compiler gate, not a claim about the
// previously vendored compiler receipt. A required run must never skip.
const required=process.env.ATTO_EXPLICIT_TERNARY_BROWSER_REQUIRED==='1';
const sourceHead='3d882edf00ff5b5e519239882c45ff3a76872fbf';
const sourceTree='92dbde9996412a1a10ec72b23abdced9aa002c48';

test('exact Rust-built browser compiler executes explicit ternary arms',{skip:!required},async()=>{
  assert.equal(process.env.ATTO_BROWSER_SOURCE_SHA,sourceHead);
  assert.equal(process.env.ATTO_BROWSER_SOURCE_TREE,sourceTree);
  assert.match(process.env.ATTO_BROWSER_COMPILER_SHA256??'',/^[a-f0-9]{64}$/);
  assert.ok(process.env.ATTO_BROWSER_COMPILER);
  const bytes=await readFile(process.env.ATTO_BROWSER_COMPILER);
  const digest=createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest,process.env.ATTO_BROWSER_COMPILER_SHA256);
  await verifyCompilerBytes(bytes,digest,bytes.length);
  const compiler=await createCompiler(bytes);
  for(const [source,expected] of [
    ['pub fnc main(): int { return true ? { return 42; } : { ^ 7; }; }',42n],
    ['pub fnc main(): int { return false ? 7 : { ^ 42; }; }',42n],
    ['pub fnc main(): int { return true ? { return false ? 7 : 42; } : 0; }',42n],
    ['pub fnc main(): int { return true ? { ^ 42; } : { return 9223372036854775807 + 1; }; }',42n]
  ]){
    const result=compiler.compile(source);
    assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
    const mod=new WebAssembly.Module(result.wasm);
    assert.deepEqual(WebAssembly.Module.imports(mod),[]);
    const instance=new WebAssembly.Instance(mod,{});
    assert.equal(instance.exports.main(),expected);
  }
  for(const arm of ['{}','{status:42}','{42}','{val x = 42; return x;}']){
    const result=compiler.compile('pub fnc main(): int { return true ? '+arm+' : 7; }');
    assert.equal(result.ok,false);
    assert.equal('wasm' in result,false);
    assert.match(result.diagnostics[0].message,/E_VALUE_ARM/);
  }
  const negative=compiler.compile('pub fnc main(): int { return false ? 7 : {}; }');
  assert.equal(negative.ok,false);
  assert.equal('wasm' in negative,false);
  assert.match(negative.diagnostics[0].message,/E_VALUE_ARM/);
});
