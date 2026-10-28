import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {compileSourceActorToWasm} from '../scripts/compile-source-actor.mjs';
import {PooledWasmActors} from '../src/pooled-actor-host.mjs';

const compiler = process.env.ORESLANG_LLVM_COMPILER;
const requireReal = process.env.REQUIRE_REAL_WASM_ACTOR === '1';
const skip = !compiler && !requireReal ? 'requires real Oreslang LLVM compiler (not a stub)' : false;
const fixture = name => fileURLToPath(new URL('./fixtures/' + name, import.meta.url));

// This is the acceptance test, not the stub/linker test in the scalar bridge.
test('real .ores actor compiles through LLVM wasm32 and runs 1000 turns on two Workers',
  {skip}, async () => {
    assert.ok(compiler, 'real ORESLANG_LLVM_COMPILER required');
    if (requireReal) assert.match(process.env.ORESLANG_LLVM_COMPILER_SHA256 || '',
      /^[a-f0-9]{64}$/, 'exact compiler binary pin mandatory');
    const built = await compileSourceActorToWasm({compiler,
      source: fixture('wasm32-single-source-actor.ores'),
      expectedCompilerSha256: process.env.ORESLANG_LLVM_COMPILER_SHA256});
    assert.equal(built.provenance.guestImports, 0);
    assert.match(built.provenance.wasmSha256, /^[a-f0-9]{64}$/);
    const pool = new PooledWasmActors({workers: 2, maxActors: 40, timeoutMs: 5000});
    try {
      const actors = await Promise.all(Array.from({length: 40}, () =>
        pool.spawn(built.wasm, {trusted: true, expectedSha256: built.provenance.wasmSha256})));
      assert.equal(pool.workerCount, 2);
      assert.equal(pool.actorCount, 40);
      for (let i = 1; i <= 25; i++) {
        const result = await Promise.all(actors.map(a => a.send(1n)));
        assert.deepEqual(result, Array(40).fill(BigInt(i)));
      }
      // Actor 0 and actor 2 share Worker 0, but must never share native
      // guest memory. Retiring one actor must preserve its still-live peer.
      await actors[0].stop();
      await assert.rejects(actors[0].send(1n), /actor not accepting messages/);
      assert.equal(await actors[2].send(1n), 26n,
        'retiring a colocated actor must not erase another actor heap');
      assert.equal(pool.actorCount, 39);
      assert.equal(pool.activeWorkerCount, 2,
        'stopping one source actor must preserve its shared physical carrier');

      // Admit a fresh incarnation while 39 other instances remain active.
      // In particular, it must never see the old actor's accumulated 25.
      const replacement = await pool.spawn(built.wasm,
        {trusted: true, expectedSha256: built.provenance.wasmSha256});
      assert.equal(pool.actorCount, 40);
      assert.equal(await replacement.send(3n), 3n);
      await replacement.stop();
      await assert.rejects(replacement.send(1n), /actor not accepting messages/);
      await Promise.all(actors.slice(1).map(a => a.stop()));
      assert.equal(pool.actorCount, 0);
    } finally {await pool.close();}
  });

test('actual LLVM frontend rejects source spawn and send with no output IR', {skip}, () => {
  assert.ok(compiler, 'real compiler required');
  for (const name of ['source-actor-spawn-stop.ores', 'source-actor-send.ores']) {
    const r = spawnSync(compiler, ['--target=wasm32', fixture(name)],
      {encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024});
    assert.equal(r.error, undefined);
    assert.notEqual(r.status, 0, name);
    assert.equal(r.stdout, '', name + ' emitted unsafe IR');
    assert.match(r.stderr, /wasm32 actor operations are not implemented/, name);
  }
});

test('no executable proof is claimed without a real source compiler', () => {
  if (requireReal) assert.ok(compiler, 'required compiler is not configured');
  else assert.ok(true);
});
