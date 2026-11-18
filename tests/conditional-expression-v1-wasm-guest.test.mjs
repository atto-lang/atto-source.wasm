import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,readdir,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {compileOresToWasm,readBoundedRegularFile} from '../scripts/compile-ores.mjs';
import {readAtomicRelease} from '../scripts/atomic-release.mjs';
import {runIsolatedCoreGuest} from '../src/isolated-runner.mjs';
import {cleanupRealCompilerWorkspace} from '../scripts/cleanup-real-compiler.mjs';

// A shared source contract is not evidence of executed Oreslang guests.
const root = new URL('../contracts/v1/conditional-expression-v1/', import.meta.url);
const contractUrl = new URL('../contracts/v1/conditional-expression-v1.json', import.meta.url);
const contractBlob = 'e3da61d86e556e801454029acef3bc4879d954a9';
const fixtureBlobs = Object.freeze({
  literal_true:'1e2c5f0d894d449feae01fce5c11b16d3d6d2278',
  literal_false:'ca35b2101e47593dc25ab1b7f9eab9981fd5a996',
  right_associative:'69824a5f76114a87d1e2086c72ad8951b270c986',
  arithmetic_condition_precedence:'ade0e4e2335ee5398e1bd4104e8619a908024236',
  reject_integer_truthiness:'71bb3176b85cce81a3ca3d1cb00d31395bd288fd',
  skip_overflow_false_arm:'b26dfe3c9d992a8288d4121807e676813f14c9fa',
  skip_overflow_true_arm:'270db32fd5c17f3df04eb35c4bb2b2ef8fcebc13',
  execute_overflow_true_arm:'2ff391c3ff485816058ce4f2511904fc6f3d0cbf',
  execute_overflow_false_arm:'da8423aa797eb87df3e9a761b7a486447be7f3a6'
});
const sha256 = x => createHash('sha256').update(x).digest('hex');
const blob = x => createHash('sha1')
  .update(Buffer.from('blob ' + x.length + '\0','ascii')).update(x).digest('hex');

async function sourceCorpus() {
  const bytes = await readFile(contractUrl);
  assert.equal(blob(bytes),contractBlob,'shared Java/LLVM contract changed');
  const spec = JSON.parse(bytes.toString('utf8'));
  assert.equal(spec.schema,'oreslang.conditional-expression.v1');
  assert.equal(spec.ternary.condition_type,'bool');
  assert.equal(spec.ternary.associativity,'right');
  assert.equal(spec.ternary.evaluation.branches,'selected_arm_only');
  assert.deepEqual(spec.portable_scalar_vectors.map(x=>x.id),[
    'literal_true','literal_false','right_associative',
    'arithmetic_condition_precedence','reject_integer_truthiness'
  ]);
  const ids=Object.keys(fixtureBlobs);
  assert.deepEqual((await readdir(root)).filter(x=>x.endsWith('.atto')).sort(),
    ids.map(x=>x+'.atto').sort(),'unexpected/missing guest file');
  const files=new Map();
  for(const id of ids){
    const source=await readFile(new URL(id+'.atto',root));
    assert.equal(blob(source),fixtureBlobs[id],id+' Git blob pin');
    const mutation=Buffer.from(source);
    mutation[0]^=1;
    assert.notEqual(blob(mutation),fixtureBlobs[id],id+' mutation control');
    files.set(id,source);
  }
  for(const item of spec.portable_scalar_vectors)
    assert.equal(files.get(item.id).toString('utf8'),item.source+'\n',
      item.id+' contract to .atto byte identity');
  return {spec,files};
}

test('source contract and 9 canonical .atto files are exact (HOST_ONLY)',async()=>{
  const {spec}=await sourceCorpus();
  assert.deepEqual(spec.portable_scalar_vectors.map(x=>x.result??x.reject),
    [42,7,42,42,'condition_not_bool']);
});

test('real compiler gate must fail closed on missing exact provenance',()=>{
  const check=e=>{
    if(!e.ORESLANG_LLVM_COMPILER||!isAbsolute(e.ORESLANG_LLVM_COMPILER))
      throw Error('absolute LLVM compiler required');
    if(!/^[a-f0-9]{64}$/.test(e.ORESLANG_LLVM_COMPILER_SHA256??''))
      throw Error('pinned binary digest required');
    if(!/^[a-f0-9]{40}$/.test(e.ORESLANG_LLVM_SOURCE_SHA??'')||
       !/^[a-f0-9]{40}$/.test(e.ORESLANG_LLVM_SOURCE_TREE_SHA??''))
      throw Error('source commit and tree receipt required');
  };
  assert.throws(()=>check({}),/absolute LLVM/);
  assert.throws(()=>check({ORESLANG_LLVM_COMPILER:'/tmp/x'}),/binary digest/);
  assert.throws(()=>check({ORESLANG_LLVM_COMPILER:'/tmp/x',
    ORESLANG_LLVM_COMPILER_SHA256:'a'.repeat(64)}),/source commit and tree/);
});

// Ordinary npm test intentionally reports this gate as SKIPPED / NOT_EXECUTED.
// Only run with an authorized private LLVM compiler and source-owned CI receipt.
const required=process.env.ATTO_WASM_CONDITIONAL_REQUIRED==='1';
test('real LLVM-to-wasm32 conditional guest gate (9 cases)',{
  skip:!required,timeout:180000
},async()=>{
  const {spec,files}=await sourceCorpus();
  const compiler=process.env.ORESLANG_LLVM_COMPILER;
  const pin=process.env.ORESLANG_LLVM_COMPILER_SHA256;
  assert.ok(compiler&&isAbsolute(compiler),'absolute LLVM compiler required');
  assert.match(pin??'',/^[a-f0-9]{64}$/,'real compiler SHA-256 required');
  assert.match(process.env.ORESLANG_LLVM_SOURCE_SHA??'',/^[a-f0-9]{40}$/,
    'verified LLVM source head required');
  assert.match(process.env.ORESLANG_LLVM_SOURCE_TREE_SHA??'',/^[a-f0-9]{40}$/,
    'source-owned CI must verify the exact LLVM tree');
  const binary=await readBoundedRegularFile(compiler,256*1024*1024,
    'missing or oversized LLVM compiler');
  assert.equal(sha256(binary.bytes),pin,'compiler bytes do not match pin');
  const expected=new Map(spec.portable_scalar_vectors
    .filter(x=>Object.hasOwn(x,'result')).map(x=>[x.id,BigInt(x.result)]));
  expected.set('skip_overflow_false_arm',42n);
  expected.set('skip_overflow_true_arm',42n);
  const traps=new Set(['execute_overflow_true_arm','execute_overflow_false_arm']);
  const dir=await mkdtemp(join(tmpdir(),'atto-conditional-wasm-'));
  try{
    let completed=0;
    for(const [id,sourceBytes] of files){
      const source=join(dir,id+'.atto'),output=join(dir,id+'.wasm');
      await writeFile(source,sourceBytes,{flag:'wx',mode:0o400});
      const compile=()=>compileOresToWasm({
        compiler,compilerSha256:pin,source,output,
        environment:'browser',publication:'atomic'
      });
      if(id==='reject_integer_truthiness'){
        await assert.rejects(compile,error=>
          /oreslang-llvmc:/i.test(String(error?.message))&&
          /(?:condition.*bool|bool.*condition|expected bool|condition_not_bool)/i
            .test(String(error?.message)),
          'wrong or missing native compiler condition-not-bool diagnostic');
        await assert.rejects(stat(output+'.current.json'),{code:'ENOENT'});
        await assert.rejects(stat(output),{code:'ENOENT'});
      }else{
        const build=await compile();
        assert.equal(build.sourceSha256,sha256(sourceBytes),id+' source pin');
        assert.equal(build.compilerSha256,pin,id+' binary pin');
        const release=await readAtomicRelease(output);
        assert.equal(sha256(release.wasm),build.wasmSha256,id+' artifact hash');
        assert.equal(release.manifest.wasmSha256,build.wasmSha256);
        assert.deepEqual(release.manifest.imports,[],id+' imports');
        assert.deepEqual(release.manifest.requiredCapabilities,[],id+' grants');
        const run=()=>runIsolatedCoreGuest(release.wasm,{
          expectedSha256:build.wasmSha256,timeoutMs:5000
        });
        if(traps.has(id)){
          await assert.rejects(run,error=>
            /guest rejected or failed:/i.test(String(error?.message))&&
            /(?:unreachable|integer overflow|arithmetic overflow)/i
              .test(String(error?.message)),
            id+' selected overflow must trap, not wrap or time out');
        }else{
          const actual=await run();
          assert.equal(actual.value,expected.get(id),id+' executed return');
          assert.equal(actual.admission.imports,0);
          assert.equal(actual.admission.hostCapabilities,0);
        }
      }
      completed++;
    }
    assert.equal(completed,9,'incomplete real guest matrix');
  }finally{
    await cleanupRealCompilerWorkspace(dir);
  }
});
