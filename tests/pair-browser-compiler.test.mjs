import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {isAbsolute} from 'node:path';
import {createCompiler,verifyCompilerBytes} from '../src/canonical-browser-compiler.mjs';

// Target-only delegated browser compiler gate. Not evidence about the
// currently vendored compiler. Required execution must fail on missing inputs.
const head='098d8106dac0fac30d410149c635e591726f5311';
const tree='e160fb2b297552c68d3fc63a5cdd4d840e5c1619';
const required=process.env.ATTO_PAIR_BROWSER_REQUIRED==='1';
const program=body=>'pub fnc main(): int { '+body+' }';

test('real Rust wasm32 compiler admits string-key Pair and distinct Entry',{skip:!required},async()=>{
  const root=process.env.ATTO_BROWSER_SOURCE_ROOT;
  assert.ok(root&&isAbsolute(root),'authorized exact Rust checkout required');
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:5000}).trim();
  assert.equal(git('rev-parse','HEAD'),head);
  assert.equal(git('rev-parse','HEAD^{tree}'),tree);
  assert.equal(git('status','--porcelain','--untracked-files=no'),'');
  assert.equal(process.env.ATTO_BROWSER_SOURCE_SHA,head);
  assert.equal(process.env.ATTO_BROWSER_SOURCE_TREE,tree);
  const digest=process.env.ATTO_BROWSER_COMPILER_SHA256;
  assert.match(digest??'',/^[a-f0-9]{64}$/);
  assert.ok(process.env.ATTO_BROWSER_COMPILER);
  const bytes=await readFile(process.env.ATTO_BROWSER_COMPILER);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),digest);
  await verifyCompilerBytes(bytes,digest,bytes.length);
  const compiler=await createCompiler(bytes);
  for(const body of [
    'val p: Pair<int> = Pair.of("count",42); return p.second;',
    'val p: Pair<string,int> = Pair.of("count",42); return p.second;',
    'val p = Pair.of("first-name",42); return p.second;',
    'val e: Entry<int,int> = Entry.of(42,5); return e.key;',
    'val e = Entry.of(42,5); return e.key;',
    'val p: Pair<int> = Pair.of<string,int>("name",42); return p.second;',
    'val p = Pair.of<int>("name",20+22); return p.second;',
    'val e = Entry.of<int,int>(20+22,5); return e.key;',
    'return (2 + 5) * 6;'
  ]){
    const result=compiler.compile(program(body));
    assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
    const mod=new WebAssembly.Module(result.wasm);
    assert.deepEqual(WebAssembly.Module.imports(mod),[]);
    const instance=new WebAssembly.Instance(mod,{});
    assert.equal(instance.exports.main(),42n);
    assert.equal(instance.exports.panic_code.value,0);
  }
  const dynamicSource='fnc make(string key, int value): int { val p = Pair.of<int>(key,value); return p.second; }\n'+program('return make("runtime",42);');
  const dynamic=compiler.compile(dynamicSource);
  assert.equal(dynamic.ok,true,JSON.stringify(dynamic.diagnostics));
  const dynamicGuest=new WebAssembly.Instance(new WebAssembly.Module(dynamic.wasm),{});
  assert.equal(dynamicGuest.exports.main(),42n);
  assert.equal(dynamicGuest.exports.panic_code.value,0);
  for(const body of [
    'val p: Pair<int> = Pair.of<bool>("a",true); return 0;',
    'val e: Entry<int,int> = Entry.of<string,int>("a",5); return 0;',
    'val p = Pair.of<int>(42,5); return 0;',
    'val p = Pair.of<int,int>(42,5); return 0;',
    'val Entry=1; val e=Entry.of(42,5); return 0;',
    'val p = Pair.of<int>("a",(5]); return 0;',
    'val e = Entry.of<int,int>(42,[5)); return 0;',
    'val p = Pair.of<int>("a",5); return p.key;',
    'val p = Pair.of(42,5); return 0;',
    'val p = Pair.of(true,5); return 0;',
    'val p: Pair<int,int> = Pair(42,5); return 0;',
    'val p: Pair<int> = Pair.of(); return 0;',
    'val p: Pair<int> = Pair.of(42,5); return 0;',
    'return (5,,6);',
    'return (5,[6),7];'
  ]){
    const result=compiler.compile(program(body));
    assert.equal(result.ok,false,body);
    assert.equal('wasm' in result,false,body);
    assert.ok(result.diagnostics.length>0,body);
    // A rejected source must not leak a stale artifact or poison later valid compilations.
    const recovery=compiler.compile(program('return 42;'));
    assert.equal(recovery.ok,true,JSON.stringify(recovery.diagnostics));
    const recovered=new WebAssembly.Instance(new WebAssembly.Module(recovery.wasm),{});
    assert.equal(recovered.exports.main(),42n);
    assert.equal(recovered.exports.panic_code.value,0);
  }
});
