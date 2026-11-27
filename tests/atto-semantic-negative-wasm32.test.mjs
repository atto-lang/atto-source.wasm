import {cleanupRealCompilerWorkspace} from '../scripts/cleanup-real-compiler.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {compileOresToWasm} from '../scripts/compile-ores.mjs';
import {readAtomicRelease} from '../scripts/atomic-release.mjs';
import {semanticCompilerRejection} from '../src/oresllm-compiler-evidence.mjs';

// Wasm uses an independently pinned *LLVM* compiler binary. This does not
// prove an independent Wasm frontend. All source bytes mirror Java+LLVM.
const cases=[
  ['removed-modulo','pub fnc main(): int { return 9 % 2; }\n',
    '45d5794870e93074d9b11b90833a849e96aaa4c1',/noncanonical.*%|legacy % operator/i,'SEMANTIC_REJECT'],
  ['removed-caret','pub fnc main(): int { return 2 ^ 3; }\n',
    '6889c7e83c8d94b906fbfe78723caee9580da6aa',/(\^|caret).*(operator|removed)|(operator|removed).*(\^|caret)/i,'SEMANTIC_REJECT'],
  ['removed-double-caret','pub fnc main(): int { return 2 ^^ 3; }\n',
    '7ee99948018e927cce74c9ad0edc1975e4251689',/(\^\^|double caret).*(operator|removed)|(operator|removed).*(\^\^|double caret)/i,'SEMANTIC_REJECT'],
  ['type-first-reassignment','pub fnc main(): int { int x = 7; x = 8; return x; }\n',
    'b118f53e68565dcb9e6acd58deb8ee47dca67606',null,'UNSUPPORTED_NOT_SEMANTIC_PROOF'],
  ['typed-const-reassignment','pub fnc main(): int { const int x = 7; x = 8; return x; }\n',
    '784ebd47a50211e6f00cb732cc74319ed1e58fac',null,'UNSUPPORTED_NOT_SEMANTIC_PROOF'],
  ['legacy-async-modifier',
    '// Legacy async is forbidden for functions; use suspends instead.\nasync fnc main(): int {\n  return 0;\n}\n',
    '26d392c8f609a730e81b503d9495de7e29b46755',/async.*(modifier|forbidden|unsupported|removed)/i,'SEMANTIC_REJECT'],
  ['critical-suspends-modifier',
    '// A critical function must never carry a suspending modifier.\ncritical suspends fnc main(): int {\n  return 0;\n}\n',
    '6be781ff89f9ebc48ee5870d3401943d50b0f9db',/critical.*suspends.*(modifier|forbidden|invalid|unsupported)/i,'SEMANTIC_REJECT'],
  ['suspends-critical-modifier',
    '// Reversing the illegal modifiers must be rejected too.\nsuspends critical fnc main(): int {\n  return 0;\n}\n',
    'c8bb7c921749f06e9d187a6dfbd71685952e3d88',/(critical.*suspends|suspends.*critical).*(modifier|forbidden|invalid|unsupported)/i,'SEMANTIC_REJECT'],
];
const positives=[
  ['canonical-add','pub fnc main(): int { return 40 + 2; }\n',42n],
  ['canonical-multiply','pub fnc main(): int { return 7 * 6; }\n',42n],
  ['ignored-comment','pub fnc main(): int { /* async critical suspends % ^ ^^ */ return 42; }\n',42n]
];
const sha1=bytes=>createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const compiler=process.env.ORESLANG_LLVM_COMPILER;
const pin=process.env.ORESLANG_LLVM_COMPILER_SHA256;
const nativeHead=process.env.ORESLANG_LLVM_SOURCE_SHA;
const required=process.env.ORESLANG_REQUIRE_REAL_COMPILER==='1';

function acceptedSemanticDiagnostic(message,pattern){
  if(!pattern||typeof message!=='string'||message.length>65536) return false;
  const lines=message.toLowerCase().replace(/\\r\\n|\\n|\\r/g,'\n').split(/\r\n|\r|\n/);
  if(lines.some(line=>/unexpected token|invalid character|internal error|unknown symbol|stack overflow/i.test(line))) return false;
  return lines.some(line=>!/^\s*(?:note|help|hint|warning|info)\s*:/i.test(line)&&
    pattern.test(line)&&/error|reject|invalid|unsupported|forbidden|removed/i.test(line));
}

test('eight canonical negative .atto Git blobs and evidence stages are pinned',()=>{
  assert.equal(cases.length,8);
  assert.equal(new Set(cases.map(x=>x[0])).size,8);
  assert.equal(cases.filter(x=>x[4]==='SEMANTIC_REJECT').length,6);
  for(const [id,source,blob,oracle,stage] of cases) {
    assert.equal(sha1(Buffer.from(source)),blob,id);
    assert.ok(stage==='SEMANTIC_REJECT'||stage==='UNSUPPORTED_NOT_SEMANTIC_PROOF');
    assert.equal(Boolean(oracle),stage==='SEMANTIC_REJECT');
  }
});

test('a wrong-stage compiler error cannot masquerade as a semantic denial',()=>{
  for(const [id,,,oracle,stage] of cases) {
    assert.equal(acceptedSemanticDiagnostic('error: unexpected token '+id,oracle),false);
    assert.equal(acceptedSemanticDiagnostic('error: unknown symbol '+id,oracle),false);
    assert.equal(acceptedSemanticDiagnostic('internal error: '+id,oracle),false);
    assert.equal(acceptedSemanticDiagnostic('note: '+id,oracle),false);
    if(oracle) {
      const diagnostic={
        'removed-modulo':'error: noncanonical % operator',
        'removed-caret':'error: caret operator removed',
        'removed-double-caret':'error: double caret operator removed',
        'legacy-async-modifier':'error: async modifier forbidden',
        'critical-suspends-modifier':'error: critical suspends modifier forbidden',
        'suspends-critical-modifier':'error: suspends critical modifier forbidden'
      }[id];
      assert.ok(diagnostic && oracle.test(diagnostic),id);
      assert.equal(acceptedSemanticDiagnostic(diagnostic,oracle),true);
      for(const prefix of ['note','help','hint','warning','info']) {
        assert.equal(acceptedSemanticDiagnostic(prefix+' : '+diagnostic,oracle),false);
        for(const separator of ['\n','\r\n','\r','\\n','\\r\\n','\\r'])
          assert.equal(acceptedSemanticDiagnostic('note: context'+separator+prefix+': '+diagnostic,oracle),false);
      }
    }
    if(stage==='UNSUPPORTED_NOT_SEMANTIC_PROOF')
      assert.equal(acceptedSemanticDiagnostic('error: immutable binding x',oracle),false);
  }
});

async function admission(t){
  if(!compiler&&!pin&&!nativeHead){
    if(required) throw Error('required native compiler and provenance absent; cannot skip');
    t.skip('no compiler connected: NOT_EXECUTED, no wasm guest credit');
    return false;
  }
  assert.ok(compiler&&pin&&nativeHead,'partial native LLVM compiler identity');
  assert.match(pin,/^[a-f0-9]{64}$/);
  assert.match(nativeHead,/^[a-f0-9]{40}$/);
  assert.equal(sha256(await readFile(resolve(compiler))),pin,'compiler binary digest mismatch');
  return true;
}
async function scratch(t,source){
  const dir=await mkdtemp(join(tmpdir(),'atto-wasm-negative-'));
  t.after(()=>cleanupRealCompilerWorkspace(dir));
  const input=join(dir,'source.atto'),output=join(dir,'rejected-or-valid.wasm');
  await writeFile(input,source,{flag:'wx',mode:0o600});
  return {input,output};
}
for(const [id,source,blob,oracle,stage] of cases){
  test('pinned compiler to wasm32 negative: '+id,async t=>{
    if(!await admission(t))return;
    const {input,output}=await scratch(t,source);
    const bytes=await readFile(input);
    assert.equal(sha1(bytes),blob);
    await assert.rejects(()=>compileOresToWasm({
      compiler:resolve(compiler),compilerSha256:pin,
      source:input,output,environment:'browser',publication:'atomic'
    }),error=>{
      assert.equal(semanticCompilerRejection(error),true,
        id+': missing compiler rejection; infrastructure error is not parity');
      if(stage==='SEMANTIC_REJECT') {
        assert.ok(acceptedSemanticDiagnostic(String(error.stderr??error.message??''),oracle),
          id+': generic or unrelated compiler diagnostic must not count');
      }
      return true;
    });
    await assert.rejects(stat(output),{code:'ENOENT'});
    await assert.rejects(stat(output+'.current.json'),{code:'ENOENT'});
    assert.equal(sha1(await readFile(input)),blob,'compiler mutated exact source');
  });
}
for(const [id,source,want] of positives){
  test('pinned LLVM to actual wasm32 positive guest: '+id,async t=>{
    if(!await admission(t))return;
    const {input,output}=await scratch(t,source);
    const bytes=await readFile(input);
    const result=await compileOresToWasm({
      compiler:resolve(compiler),compilerSha256:pin,
      source:input,output,environment:'browser',publication:'atomic'
    });
    assert.equal(result.compilerSha256,pin);
    assert.equal(result.sourceSha256,sha256(bytes));
    const release=await readAtomicRelease(output);
    const wasm=release.wasm;
    assert.equal(release.manifest.wasmSha256,result.wasmSha256);
    assert.equal(result.wasmSha256,sha256(wasm));
    assert.deepEqual(release.manifest.imports,[]);
    assert.deepEqual(release.manifest.requiredCapabilities,[]);
    const {instance}=await WebAssembly.instantiate(wasm,{});
    assert.equal(typeof instance.exports.main,'function');
    assert.equal(instance.exports.main(),want);
  });
}
