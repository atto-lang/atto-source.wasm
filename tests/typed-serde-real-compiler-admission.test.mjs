// Required real compiler bridge: no host-only fake Wasm parity.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {compileOresToWasm} from '../scripts/compile-ores.mjs';
import {semanticCompilerRejection} from '../src/oresllm-compiler-evidence.mjs';

const compiler=process.env.ORESLANG_LLVM_COMPILER;
const compilerSha256=process.env.ORESLANG_LLVM_COMPILER_SHA256;
const required=process.env.ORESLANG_REQUIRE_REAL_COMPILER==='1';
test('actual wasm32 scalar guest and absent serializer admission preserve publication', {
  skip: !required && !compiler && !compilerSha256,
  timeout: 120000
}, async t=>{
  assert.ok(compiler && compilerSha256,'required real compiler must be pinned');
  assert.match(compilerSha256,/^[0-9a-f]{64}$/);
  assert.match(process.env.ORESLANG_LLVM_SOURCE_SHA||'',/^[0-9a-f]{40}$/);
  const dir=await mkdtemp(join(tmpdir(),'atto-wasm-serde-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=join(dir,'main.atto'), output=join(dir,'good.wasm');
  const compile=target=>compileOresToWasm({compiler:resolve(compiler),compilerSha256,source,output:target});
  await writeFile(source,'pub fnc main(): int { /* to_json */ return 42; }');
  await compile(output);
  const good=await readFile(output), receipt=await readFile(output+'.provenance.json');
  const {instance}=await WebAssembly.instantiate(good,{});
  assert.equal(instance.exports.main(),42n);
  const baseline=(await readdir(dir)).sort();
  for(const name of ['to_json','to_message_pack','serialize','deserialize']){
    // Unbound names must fail at the real compiler, not at a missing-tool or
    // linker failure. The declaration grammar is covered separately upstream.
    await writeFile(source,'pub fnc main(): int { return '+name+'; }');
    for(const target of [join(dir,'rejected.wasm'),output]){
      await assert.rejects(compile(target),e=>semanticCompilerRejection(e),name);
    }
    assert.deepEqual(await readFile(output),good);
    assert.deepEqual(await readFile(output+'.provenance.json'),receipt);
    assert.deepEqual((await readdir(dir)).sort(),baseline);
  }
  console.log('WASM_TYPED_SERDE_ADMISSION_PASS checks=9 NOT_SERIALIZER_EXECUTION');
});
