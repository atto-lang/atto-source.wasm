import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseThreadPolicyFlags} from '../src/runtime-thread-policy.mjs';
import {runIsolatedCoreGuest} from '../src/isolated-runner.mjs';

test('thread policy CLI aliases normalize identically', () => {
  for (const argv of [
    ['--single-threaded'], ['--max-threads-per-space=1'],
    ['--mode=single-threaded'],
    ['--single-threaded', '--max-threads-per-space=1', '--mode=single-threaded']
  ]) {
    assert.deepEqual(parseThreadPolicyFlags(argv),
      {threadPolicy:'single-threaded',remaining:[]});
  }
  assert.deepEqual(parseThreadPolicyFlags(['--wasm=/tmp/a.wasm']),
    {threadPolicy:null,remaining:['--wasm=/tmp/a.wasm']});
});

test('unknown modes, malformed limits, conflicts and duplicate flags fail closed', () => {
  const rejects = [
    ['--single-threaded','--single-threaded'],
    ['--max-threads-per-space=1','--max-threads-per-space=1'],
    ['--mode=single-threaded,single-threaded'],
    ['--mode=single-threaded','--mode=single-threaded'],
    ['--mode='], ['--mode=max1'], ['--mode=trace'],
    ['--mode=single-threaded,trace'],
    ['--mode=Single-Threaded'], ['--mode=,single-threaded'],
    ['--mode=single-threaded,'], ['--max-threads-per-space=0'],
    ['--max-threads-per-space=01'], ['--max-threads-per-space=-1'],
    ['--max-threads-per-space=+1'], ['--max-threads-per-space=1e0'],
    ['--max-threads-per-space=1.0'],
    ['--max-threads-per-space=9007199254740992'],
    ['--max-threads-per-space=2'],
    ['--single-threaded','--max-threads-per-space=2']
  ];
  for (const argv of rejects)
    assert.throws(() => parseThreadPolicyFlags(argv), /^Error: E_/,
      argv.join(' '));
});

function buildGuest() {
  const dir = mkdtempSync(join(tmpdir(),'atto-private-thread-'));
  const wasm = join(dir,'guest.wasm');
  const ir = [
    'target triple = "wasm32-unknown-unknown"',
    'define i64 @main() { ret i64 42 }',
    ''
  ].join('\n');
  const result = spawnSync(process.env.CLANG || 'clang', [
    '--target=wasm32','-x','ir','-O0','-nostdlib','-Wl,--no-entry',
    '-Wl,--export-memory','-Wl,--export=main',
    '-Wl,--initial-memory=131072','-Wl,--max-memory=131072',
    '-o',wasm,'-'
  ],{input:ir,encoding:'utf8',timeout:30000});
  if (result.error || result.status !== 0) {
    rmSync(dir,{recursive:true,force:true});
    throw Error('compiled fixture unavailable: '+(result.error?.message||result.stderr));
  }
  const bytes=readFileSync(wasm);
  return {dir,wasm,bytes,sha:createHash('sha256').update(bytes).digest('hex')};
}

test('compiled Wasm guest executes with pinned private-memory single-threaded receipt', async t => {
  const fixture=buildGuest();
  t.after(()=>rmSync(fixture.dir,{recursive:true,force:true}));
  const {value,admission}=await runIsolatedCoreGuest(fixture.bytes,{
    expectedSha256:fixture.sha,threadPolicy:'single-threaded'
  });
  assert.equal(value,42n);
  assert.equal(admission.sha256,fixture.sha);
  assert.equal(admission.imports,0);
  assert.equal(admission.hostCapabilities,0);
  assert.equal(admission.threadPolicy,'single-threaded');
  assert.equal(admission.memoryMaximumPages,2);

  const runScript=resolve(fileURLToPath(new URL('../scripts/run-guest.mjs',import.meta.url)));
  for(const flag of ['--single-threaded','--max-threads-per-space=1','--mode=single-threaded']){
    const result=spawnSync(process.execPath,[runScript,
      '--wasm='+fixture.wasm,'--sha256='+fixture.sha,flag
    ],{encoding:'utf8',timeout:15000});
    assert.equal(result.status,0,result.stderr);
    const receipt=JSON.parse(result.stdout);
    assert.equal(receipt.value,'42');
    assert.equal(receipt.admission.threadPolicy,'single-threaded');
  }
});

test('no policy in legacy guest path does not claim explicit policy', async t => {
  const fixture=buildGuest();
  t.after(()=>rmSync(fixture.dir,{recursive:true,force:true}));
  const result=await runIsolatedCoreGuest(fixture.bytes,{expectedSha256:fixture.sha});
  assert.equal(result.value,42n);
  assert.equal(Object.hasOwn(result.admission,'threadPolicy'),false);
});

test('unsafe shared or imported guest memory is rejected under requested policy', async () => {
  // One shared memory, no imports. Memory flags 3 are deliberately forbidden.
  const shared=Uint8Array.from([0,97,115,109,1,0,0,0,5,4,1,3,1,1]);
  await assert.rejects(runIsolatedCoreGuest(shared,{threadPolicy:'single-threaded'}),
    /shared\/memory64 forbidden/);
  await assert.rejects(runIsolatedCoreGuest(shared,{threadPolicy:'not-a-mode'}),
    /unsupported guest threading policy/);
  await assert.rejects(runIsolatedCoreGuest(shared,{threadPolicy:1}),
    /unsupported guest threading policy/);
});
