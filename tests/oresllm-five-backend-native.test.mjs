// Real Wasm guest execution when ORESLANG_LLVM_COMPILER is configured.
// Without a pinned compiler this suite skips, NEVER claims parity.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {compileOresToWasm} from '../scripts/compile-ores.mjs';

const c=JSON.parse(readFileSync(new URL('../contracts/oresllm-parity/v1/scalar.json',import.meta.url),'utf8'));
const compiler=process.env.ORESLANG_LLVM_COMPILER;
const compilerSha256=process.env.ORESLANG_LLVM_COMPILER_SHA256;
const required=process.env.ORESLLM_REQUIRE_REAL_WASM_PARITY==='1';
async function withFixture(t,expression,check){
  if(!compiler){
    if(required)throw Error('WASM parity requires pinned ORESLANG_LLVM_COMPILER');
    t.skip('no compiler pinned; not a native guest pass');
    return;
  }
  if(!/^[0-9a-f]{64}$/.test(compilerSha256||'')){
    throw Error('WASM native parity requires 64-character lowercase pinned ORESLANG_LLVM_COMPILER_SHA256');
  }
  const dir=await mkdtemp(join(tmpdir(),'oresllm-wasm-parity-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=join(dir,'input.ores'),output=join(dir,'input.wasm');
  await writeFile(source,'// oreslang:checked-i64-v1\n' +
    'define pub fnc main(): int { return '+expression+'; }\n');
  await check({source,output,compiler:resolve(compiler),compilerSha256});
}
for(const x of c.positive){
  test('WASM native guest positive '+x.id,async t=>withFixture(t,x.expression,async({source,output,compiler,compilerSha256})=>{
    await compileOresToWasm({compiler,source,output,compilerSha256});
    const {instance}=await WebAssembly.instantiate(await readFile(output),{});
    assert.equal(typeof instance.exports.main,'function');
    assert.equal(instance.exports.main(),BigInt(x.expected_i64));
  }));
}
for(const x of c.checked_overflow){
  test('WASM native guest checked overflow '+x.id,async t=>withFixture(t,x.expression,async({source,output,compiler,compilerSha256})=>{
    await compileOresToWasm({compiler,source,output,compilerSha256});
    const {instance}=await WebAssembly.instantiate(await readFile(output),{});
    assert.throws(()=>instance.exports.main(),WebAssembly.RuntimeError);
  }));
}
for(const x of c.compile_reject){
  test('WASM compiler rejects invalid source '+x.id,async t=>withFixture(t,x.expression,async({source,output,compiler,compilerSha256})=>{
    await assert.rejects(()=>compileOresToWasm({compiler,source,output,compilerSha256}),error=>{
      const message=String(error?.message||'');
      // Only a NONZERO compiler invocation counts as a parser rejection.
      // Missing compiler, clang/linker failure, digest mismatch, IO and timeouts
      // are infrastructure failures, never successful negative guest evidence.
      assert.match(message,/^command failed \\(.*compiler-exact\\):/);
      assert.doesNotMatch(message,/ENOENT|EACCES|ETIMEDOUT|timed out|spawn|no such file/i);
      return true;
    });
  }));
}
test('WASM native parity cannot be silently certified without compiler or digest',t=>{
  if(compiler){
    assert.match(compilerSha256||'',/^[0-9a-f]{64}$/,'native compiler digest not pinned');
    t.skip('compiler path and SHA provided; compiler-backed guest tests must run');return;
  }
  assert.equal(required,false,'required WASM guest proof missing pinned compiler');
});

for(const [id,expression,expected] of [
  ['zero-product','-7 * 0','0'],
  ['nested-arithmetic','(2 + 3) * (10 - 2)','40'],
  ['subtract-self','9223372036854775807 - 9223372036854775807','0']
]){
  test('WASM supplemental compiled guest '+id,async t=>
    withFixture(t,expression,async({source,output,compiler,compilerSha256})=>{
      await compileOresToWasm({compiler,source,output,compilerSha256});
      const {instance}=await WebAssembly.instantiate(await readFile(output),{});
      assert.equal(typeof instance.exports.main,'function');
      assert.equal(instance.exports.main(),BigInt(expected));
    }));
}
