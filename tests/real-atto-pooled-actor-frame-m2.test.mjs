import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compileSourceActorToWasm} from '../scripts/compile-source-actor.mjs';
import {PooledWasmActors} from '../src/pooled-actor-host.mjs';

const name = 'canonical .atto M2 frame compiles into real pooled Wasm guest; actor isolation, STOP, restart';
const compiler = process.env.ORESLANG_LLVM_COMPILER;
const pinned = process.env.ORESLANG_LLVM_COMPILER_SHA256;
const mandatory = process.env.REQUIRE_REAL_ATTO_WASM_FRAME === '1';
const skip = !compiler && !mandatory ? 'requires pinned real LLVM Atto compiler' : false;

test(name, {skip}, async () => {
  assert.ok(compiler, 'source LLVM compiler must be executable');
  assert.match(pinned || '', /^[a-f0-9]{64}$/,
    'exact compiler executable SHA-256 mandatory');
  const source = fileURLToPath(new URL('./fixtures/wasm32-actor-owned-scalar-frame.atto',
    import.meta.url));
  const built = await compileSourceActorToWasm({
    compiler, source, expectedCompilerSha256: pinned, requireActorFrameV1: true
  });
  assert.equal(built.provenance.actorFrameAbi, 'atto-wasm-actor-scalar-frame-v1');
  assert.equal(built.provenance.actorFrameCells, 2);
  assert.equal(built.provenance.actorFrameBytes, 16);
  assert.equal(built.provenance.guestImports, 0);
  const pool = new PooledWasmActors({workers: 2, maxActors: 8, timeoutMs: 5000});
  try {
    const actors = await Promise.all(Array.from({length: 8}, () =>
      pool.spawn(built.wasm,
        {trusted: true, expectedSha256: built.provenance.wasmSha256})));
    assert.equal(pool.workerCount, 2);
    assert.equal(pool.actorCount, 8);
    for (let turn = 1; turn <= 16; turn++) {
      const results = await Promise.all(actors.map(actor => actor.send(1n)));
      assert.deepEqual(results, Array(8).fill(BigInt(turn)));
    }
    await actors[0].stop();
    await assert.rejects(actors[0].send(1n), /actor not accepting messages/);
    assert.equal(await actors[2].send(3n), 19n,
      'STOP must not corrupt peer actor on same Worker');
    const fresh = await pool.spawn(built.wasm,
      {trusted: true, expectedSha256: built.provenance.wasmSha256});
    assert.equal(await fresh.send(7n), 7n,
      'reincarnated actor must not inherit previous guest heap/frames');
    assert.equal(await actors[1].send(2n), 18n);
    await fresh.stop();
    await Promise.all(actors.slice(1).map(actor => actor.stop()));
    assert.equal(pool.actorCount, 0);
    console.log('EXECUTED_ATTO_POOLED_FRAME_M2',
      JSON.stringify(built.provenance));
  } finally {await pool.close();}
});

test('canonical .atto nullable Node actor graph is rejected before Wasm32 guest emission', {skip}, async()=>{
  assert.ok(compiler,'real pinned compiler required for negative guest admission');
  assert.match(pinned || '',/^[a-f0-9]{64}$/);
  const source=fileURLToPath(new URL('./fixtures/hybrid-memory-v1-node-graph.atto',import.meta.url));
  const bytes=readFileSync(source);
  const blob=createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
  assert.equal(blob,'d472cccb3da24ee8f9fed44f99c1c7742d3240de',
    'Node actor graph must match canonical conformance source blob');
  // A reject is only valid when it comes from an actually invoked and pinned
  // LLVM compiler, not a missing compiler binary or a linker failure.
  await assert.rejects(
    compileSourceActorToWasm({
      compiler,source,expectedCompilerSha256:pinned,requireActorFrameV1:true
    }),
    /E_ATTO_SOURCE_REJECTED:/,
    'unverified typed Ref32 class graph must never generate a pooled Wasm artifact');
});

test('negative guest gate cannot mistake compiler crash, no diagnostic or partial IR for rejection',
  {skip: process.platform==='win32' ? 'POSIX test compiler launch' : false},async()=>{
  // These shell scripts deliberately are NOT Atto compilers; they only prove
  // the error-classification guard cannot turn toolchain failure into a
  // positive fail-closed guest receipt.
  const dir=await mkdtemp(join(tmpdir(),'atto-negative-compiler-'));
  try {
    const source=fileURLToPath(new URL('./fixtures/hybrid-memory-v1-node-graph.atto',import.meta.url));
    const candidate=join(dir,'compiler-exact');
    const cases=[
      {script:'#!/bin/sh\necho "unsupported nominal class" >&2\nexit 3\n',code:'E_ATTO_SOURCE_REJECTED'},
      {script:'#!/bin/sh\nexit 3\n',code:'E_ATTO_COMPILER_DIAGNOSTIC_MISSING'},
      {script:'#!/bin/sh\necho "define i32 @main()"\necho "unsupported" >&2\nexit 3\n',
       code:'E_ATTO_COMPILER_EMITTED_IR_ON_REJECT'},
      {script:'#!/definitely/missing/interpreter\nexit 3\n',code:'E_ATTO_COMPILER_INFRASTRUCTURE'}
    ];
    for(const c of cases){
      const bytes=Buffer.from(c.script);
      await writeFile(candidate,bytes,{mode:0o700});
      const expectedCompilerSha256=createHash('sha256').update(bytes).digest('hex');
      await assert.rejects(
        compileSourceActorToWasm({compiler:candidate,source,
          expectedCompilerSha256,requireActorFrameV1:true}),
        error=>error instanceof Error && error.message.startsWith(c.code+':'),
        'compiler error classification must be exact: '+c.code);
    }
  } finally {await rm(dir,{recursive:true,force:true});}
});
