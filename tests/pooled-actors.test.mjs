import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {PooledWasmActors} from '../src/pooled-actor-host.mjs';

function compile({spin = false, invalidImport = false} = {}) {
  const path = mkdtempSync(join(tmpdir(), 'ores-wasm-pool-'));
  const output = join(path, 'actor.wasm');
  const ir = [
    'target triple = "wasm32-unknown-unknown"',
    '@counter = internal global i64 0',
    ...(invalidImport ? ['declare i64 @forbidden()'] : []),
    'define void @oreslang_wasm_actor_init() { ret void }',
    'define i64 @oreslang_wasm_actor_on_message(i64 %value) {',
    'entry:',
    ...(spin ? ['br label %spin', 'spin:', 'br label %spin'] :
      invalidImport ? ['%x = call i64 @forbidden()', 'ret i64 %x'] : [
      '%old = load i64, ptr @counter',
      '%next = add i64 %old, %value',
      'store i64 %next, ptr @counter',
      'ret i64 %next'
    ]),
    '}',
    'define void @oreslang_wasm_actor_teardown() { ret void }',
    ''
  ].join('\n');
  const args = ['--target=wasm32', '-x', 'ir', '-O0', '-nostdlib',
    '-Wl,--no-entry', '-Wl,--export-memory',
    '-Wl,--export=oreslang_wasm_actor_init',
    '-Wl,--export=oreslang_wasm_actor_on_message',
    '-Wl,--export=oreslang_wasm_actor_teardown',
    '-Wl,--initial-memory=131072', '-Wl,--max-memory=131072',
    ...(invalidImport ? ['-Wl,--allow-undefined'] : []), '-o', output, '-'];
  try {
    const r = spawnSync(process.env.CLANG || 'clang', args, {
      input: ir, encoding: 'utf8', timeout: 30000
    });
    if (r.error || r.status !== 0) throw Error(r.error?.message || r.stderr);
    return readFileSync(output);
  } finally {rmSync(path, {recursive: true, force: true});}
}
const pin = bytes => createHash('sha256').update(bytes).digest('hex');

test('40 private WASM actors share two OS Workers and preserve per-actor state', async () => {
  const wasm = compile();
  const pool = new PooledWasmActors({workers: 2, maxActors: 40});
  try {
    const actors = await Promise.all(Array.from({length: 40}, () =>
      pool.spawn(wasm, {expectedSha256: pin(wasm), trusted: true})));
    assert.equal(pool.workerCount, 2);
    assert.equal(pool.actorCount, 40);
    assert.deepEqual(await Promise.all(actors.map(a => a.send(1n))), Array(40).fill(1n));
    assert.deepEqual(await Promise.all(actors.map(a => a.send(7n))), Array(40).fill(8n));
    await Promise.all(actors.map(a => a.stop()));
    assert.equal(pool.actorCount, 0);
    await assert.rejects(actors[0].send(2n), /not accepting/);
  } finally {await pool.close();}
});

test('bounded admission, ordered sender turns, closed actor and no hidden host imports', async () => {
  const wasm = compile();
  const pool = new PooledWasmActors({workers: 1, mailboxCapacity: 2});
  try {
    await assert.rejects(pool.spawn(wasm, {expectedSha256: pin(wasm)}), /require trusted/);
    await assert.rejects(pool.spawn(wasm, {trusted: true, expectedSha256: '0'.repeat(64)}), /digest mismatch/);
    const actor = await pool.spawn(wasm, {expectedSha256: pin(wasm), trusted: true});
    const a = actor.send(4n), b = actor.send(3n);
    await assert.rejects(actor.send(2n), /mailbox full/);
    assert.deepEqual(await Promise.all([a, b]), [4n, 7n]);
    await assert.rejects(actor.send(1), /signed i64/);
    await actor.stop();
    await assert.rejects(actor.send(1n), /not accepting/);
    const bad = compile({invalidImport: true});
    await assert.rejects(pool.spawn(bad, {expectedSha256: pin(bad), trusted: true}),
      /host imports denied/);
  } finally {await pool.close();}
});

test('noncooperating turn times out and kills its entire shared carrier', async () => {
  const wasm = compile({spin: true});
  const pool = new PooledWasmActors({workers: 1, timeoutMs: 300});
  const a = await pool.spawn(wasm, {expectedSha256: pin(wasm), trusted: true});
  const trapped = a.send(1n);
  await assert.rejects(trapped, /deadline exceeded/);
  assert.equal(pool.actorCount, 0);
  await assert.rejects(a.send(2n), /not accepting/);
  await pool.close();
});
