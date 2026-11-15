// Actual wasm32 guest admission requires the pinned LLVM compiler; Node-only
// checks below do NOT attest to compiler, borrow checker or executed guest parity.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdtemp,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {compileOresToWasm,readBoundedRegularFile} from '../scripts/compile-ores.mjs';
import {readAtomicRelease} from '../scripts/atomic-release.mjs';
import {runIsolatedCoreGuest} from '../src/isolated-runner.mjs';
import {cleanupRealCompilerWorkspace} from '../scripts/cleanup-real-compiler.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const gitBlob = bytes => createHash('sha1')
  .update(Buffer.from('blob ' + bytes.length + '\0','ascii'))
  .update(bytes).digest('hex');
const fixtureBlobPins = Object.freeze({
  'copy-compact': 'a4acedaaf55d03f0fe811875e7dfc70cd64e3c0b',
  'copy-spaced': '7b7728f93d9478b43c9caf0de7c1a60e666ac1a6',
  'legacy-copy': 'ea7931b84d048ef0daba662d55b1cb32401151f7',
  'reject-space-before-bang': '4442b57173a7e0cb0f3fca80de0196337ade3bde'
});
const expected = Object.freeze({
  'copy-spaced': 'pub fnc main(): int { return copy! 42; }\n',
  'copy-compact': 'pub fnc main(): int { return copy!42; }\n',
  'legacy-copy': 'pub fnc main(): int { return rt copy 42; }\n',
  'reject-space-before-bang': 'pub fnc main(): int { return copy !42; }\n'
});

const entry = name => new URL('./fixtures/ownership-bang-v1/' + name + '.atto',import.meta.url);
async function fixtures() {
  const result = new Map();
  for (const [name, canonical] of Object.entries(expected)) {
    const bytes = await readFile(entry(name));
    assert.ok(bytes.length < 4096,'bounded source');
    assert.equal(bytes.toString('utf8'),canonical,'fixture content drift '+name);
    assert.equal(gitBlob(bytes),fixtureBlobPins[name],
      'reviewed Git blob changed '+name);
    result.set(name,bytes);
  }
  return result;
}

function compilerIdentity(e) {
  assert.ok(isAbsolute(e.ORESLANG_LLVM_COMPILER??''),'absolute native LLVM compiler required');
  assert.match(e.ORESLANG_LLVM_COMPILER_SHA256??'',/^[a-f0-9]{64}$/,'compiler executable pin required');
  assert.match(e.ORESLANG_LLVM_SOURCE_SHA??'',/^[a-f0-9]{40}$/,'exact compiler source SHA required');
  assert.match(e.ORESLANG_LLVM_SOURCE_TREE_SHA??'',/^[a-f0-9]{40}$/,'exact compiler source tree SHA required');
  return {compiler:e.ORESLANG_LLVM_COMPILER,digest:e.ORESLANG_LLVM_COMPILER_SHA256};
}

test('ownership bang .atto fixtures remain exact (SOURCE_ONLY)',async()=>{
  const data=await fixtures();
  assert.equal(data.size,4);
  assert.notEqual(sha256(data.get('copy-spaced')),sha256(data.get('copy-compact')));
});
test('required real compiler cannot silently use an unpinned binary',()=>{
  assert.throws(()=>compilerIdentity({}),/absolute native/);
  assert.throws(()=>compilerIdentity({ORESLANG_LLVM_COMPILER:'/tmp/nope'}),/executable pin/);
});

const demand=process.env.ATTO_WASM_OWNERSHIP_BANG_REQUIRED??'0';
if (!['0','1'].includes(demand))
  throw new Error('ATTO_WASM_OWNERSHIP_BANG_REQUIRED must be 0 or 1');
const required=demand==='1';
test('LLVM-to-wasm32 ownership bang source compiles and executes through actual guest', {
  skip:!required,timeout:180000
},async()=>{
  const cases=await fixtures();
  const {compiler,digest}=compilerIdentity(process.env);
  const compilerBytes=(await readBoundedRegularFile(compiler,256*1024*1024,'missing compiler')).bytes;
  assert.equal(sha256(compilerBytes),digest,'compiler binary changed');
  const work=await mkdtemp(join(tmpdir(),'atto-bang-wasm32-'));
  try {
    const pinnedCompiler=join(work,'pinned-llvmc');
    await writeFile(pinnedCompiler,compilerBytes,{flag:'wx',mode:0o500});
    let executed=0,rejected=0;
    for(const [name,bytes] of cases) {
      const source=join(work,name+'.atto'),output=join(work,name+'.wasm');
      await writeFile(source,bytes,{flag:'wx',mode:0o400});
      const compile=()=>compileOresToWasm({
        compiler:pinnedCompiler,compilerSha256:digest,source,output,
        environment:'browser',publication:'atomic'
      });
      if(name==='reject-space-before-bang') {
        await assert.rejects(compile,error=>
          /oreslang-llvmc:/i.test(String(error?.message)),
          'native compiler did not reject the invalid ownership-token boundary');
        for(const suffix of ['', '.current.json', '.artifact.json',
                             '.provenance.json', '.releases'])
          await assert.rejects(stat(output+suffix),{code:'ENOENT'},
            'invalid ownership source must not publish '+suffix);
        rejected++;
        continue;
      }
      const build=await compile();
      assert.equal(build.compilerSha256,digest);
      assert.equal(build.sourceSha256,sha256(bytes));
      const release=await readAtomicRelease(output);
      assert.equal(sha256(release.wasm),build.wasmSha256);
      assert.deepEqual(release.manifest.imports,[]);
      assert.deepEqual(release.manifest.requiredCapabilities,[]);
      const actual=await runIsolatedCoreGuest(release.wasm,{
        expectedSha256:build.wasmSha256,timeoutMs:5000
      });
      assert.equal(actual.value,42n,'ownership alias guest value '+name);
      assert.equal(actual.admission.imports,0);
      assert.equal(actual.admission.hostCapabilities,0);
      executed++;
    }
    assert.equal(executed,3);
    assert.equal(rejected,1);
  }finally {
    await cleanupRealCompilerWorkspace(work);
  }
});
