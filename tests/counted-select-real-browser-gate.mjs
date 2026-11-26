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
test('shared counted fixtures reject in both real browser compiler emitters',async()=>{
  const manifest=JSON.parse(await readFile(corpusPath+'/manifest.json','utf8'));
  const cases=manifest.cases.filter(c=>/^(?:counted-|reject-counted-)/.test(c.id));
  assert.equal(cases.length,9);
  for(const c of cases){
    const raw=await readFile(corpusPath+'/'+c.path);
    const digest=createHash('sha1').update('blob '+raw.length+'\0').update(raw).digest('hex');
    assert.equal(digest,c.gitBlobSha1,c.id);
    for(const target of ['wasm','javascript']){
      const result=compiler.compile(raw.toString('utf8'),target);
      assert.equal(result.ok,false,c.id+' '+target);
      assert.equal('wasm' in result,false);
      assert.equal('esm' in result,false);
      assert.ok(result.diagnostics.length);
    }
  }
});
test('isolated counted headers reject without publishing either artifact',()=>{
  for(const prefix of ['select','nb select','await select','await nb select'])
    for(const header of ['(3)','<int>(3)','(0)','(-1)','(true)','(1+2)'])
      for(const body of ['{ default: -> { return 42; } }','over default: -> { return 42; } end'])
        for(const target of ['wasm','javascript']){
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
});
