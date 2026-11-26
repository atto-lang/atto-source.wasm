import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createCompiler,verifyCompilerBytes} from '../src/canonical-browser-compiler.mjs';

// A freshly built Rust compiler must be supplied explicitly. Never silently
// skip this dedicated gate or substitute the vendored historical binary.
const compilerPath=process.env.ATTO_COUNTED_COMPILER_WASM;
const corpusPath=process.env.ATTO_COUNTED_CORPUS;
const expected=process.env.ATTO_COUNTED_COMPILER_SHA256;
assert.ok(compilerPath && corpusPath && /^[a-f0-9]{64}$/.test(expected??''),
  'require exact built compiler and shared corpus');
const bytes=await readFile(compilerPath);
await verifyCompilerBytes(bytes,expected,bytes.length);
const compiler=await createCompiler(bytes);
const exported=WebAssembly.Module.exports(new WebAssembly.Module(bytes));
const hasEsm=exported.some(e=>e.name==='compile_js'&&e.kind==='function');
const targets=hasEsm?['wasm','javascript']:['wasm'];
test('ESM emitter capability is explicit, not a guest rejection',()=>{
  if(!hasEsm) {
    assert.throws(()=>compiler.compile('pub fnc main(): int { return 42; }','javascript'),/no JavaScript emitter/);
    console.log('COUNTED_BROWSER_ESM_UNAVAILABLE: no source admission or guest parity evidence');
  } else {
    assert.equal(compiler.compile('pub fnc main(): int { return 42; }','javascript').ok,true);
  }
});
test('shared counted fixtures reject in available real browser compiler emitters',async()=>{
  const manifest=JSON.parse(await readFile(corpusPath+'/manifest.json','utf8'));
  const cases=manifest.cases.filter(c=>/^(?:counted-|reject-counted-)/.test(c.id));
  assert.equal(cases.length,17);
  assert.deepEqual(cases.map(c=>c.id).sort(),["counted-alias","counted-distinct-alias-projection","counted-dynamic","counted-dynamic-zero","counted-mixed-future-alias","counted-mixed-zero","counted-multi-channel-fair","counted-one","counted-three","counted-zero","reject-counted-bool","reject-counted-default","reject-counted-dynamic-bool","reject-counted-dynamic-unknown","reject-counted-negative","reject-counted-scalar","reject-counted-write"]);
  for(const c of cases){
    const raw=await readFile(corpusPath+'/'+c.path);
    const digest=createHash('sha1').update('blob '+raw.length+'\0').update(raw).digest('hex');
    assert.equal(digest,c.gitBlobSha1,c.id);
    for(const target of targets){
      const result=compiler.compile(raw.toString('utf8'),target);
      assert.equal(result.ok,false,c.id+' '+target);
      assert.equal('wasm' in result,false);
      assert.equal('esm' in result,false);
      assert.ok(result.diagnostics.length);
    }
  }
});
test('isolated counted headers reject without publishing an artifact',()=>{
  for(const prefix of ['select','nb select','await select','await nb select'])
    for(const header of ['(3)','<int>(3)','(0)','(-1)','(true)','(1+2)','(count)'])
      for(const body of ['{ default: -> { return 42; } }','over default: -> { return 42; } end'])
        for(const target of targets){
          const result=compiler.compile('pub fnc main(): int { return '+prefix+header+' '+body+'; }',target);
          assert.equal(result.ok,false,prefix+header+' '+target);
          assert.equal('wasm' in result,false);assert.equal('esm' in result,false);
        }
});
test('real compiled procedural control executes in Wasm after all rejections',async()=>{
  const source='pub fnc main(): int { do select { default: -> { return 42; } } return 99; }';
  const result=compiler.compile(source);
  assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
  const {instance}=await WebAssembly.instantiate(result.wasm,{atto:{}});
  assert.equal(instance.exports.main(),42n);
  assert.equal(instance.exports.panic_code.value,0);
  console.log('COUNTED_BROWSER_ADMISSION_PASS targets='+targets.join(',')+' exact_blobs=17 isolated=56 procedural_control=42; COUNTED_GUEST_NOT_EXECUTED');
});
