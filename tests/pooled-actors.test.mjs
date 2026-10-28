import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {PooledWasmActors} from '../src/pooled-actor-host.mjs';

function compile({spin = false, invalidImport = false, linearHeap = false} = {}) {
  if (linearHeap && (spin || invalidImport)) throw TypeError('linear heap fixture is standalone');
  const path = mkdtempSync(join(tmpdir(), 'ores-wasm-pool-'));
  const output = join(path, 'actor.wasm');
  const ir = [
    'target triple = "wasm32-unknown-unknown"',
    ...(linearHeap ? [] : ['@counter = internal global i64 0']),
    ...(invalidImport ? ['declare i64 @forbidden()'] : []),
    'define void @oreslang_wasm_actor_init() { ret void }',
    'define i64 @oreslang_wasm_actor_on_message(i64 %value) {',
    'entry:',
    ...(spin ? ['br label %spin', 'spin:', 'br label %spin'] :
      invalidImport ? ['%x = call i64 @forbidden()', 'ret i64 %x'] : linearHeap ? [
      // Deliberately use actual private wasm linear memory at a fixed in-bounds
      // address, NOT a compiler global. Clang links this synthetic LLVM IR.
      '%base = inttoptr i32 1024 to ptr',
      '%old = load volatile i64, ptr %base, align 8',
      '%next = add i64 %old, %value',
      'store volatile i64 %next, ptr %base, align 8',
      'ret i64 %next'
    ] : [
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

test('two actors on one Worker retain independent linear-memory heaps across STOP and restart', async () => {
  // Host/runtime verification with independently authored LLVM IR, NOT a
  // compiled Oreslang .ores actor. Source compilation is a separate gate.
  const wasm = compile({linearHeap: true});
  assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(wasm)), []);
  const pool = new PooledWasmActors({workers: 1, maxActors: 2});
  const expectedSha256 = pin(wasm);
  try {
    const left = await pool.spawn(wasm, {trusted: true, expectedSha256});
    const right = await pool.spawn(wasm, {trusted: true, expectedSha256});
    assert.equal(pool.actorCount, 2);
    assert.equal(await left.send(21n), 21n);
    assert.equal(await right.send(7n), 7n);
    assert.equal(await left.send(1n), 22n);
    await left.stop();
    await assert.rejects(left.send(2n), /not accepting/);
    assert.equal(pool.activeWorkerCount, 1, 'colocated carrier must survive STOP');
    assert.equal(await right.send(2n), 9n,
      'retirement of left must not zero the right actor private linear memory');
    const fresh = await pool.spawn(wasm, {trusted: true, expectedSha256});
    assert.equal(await fresh.send(3n), 3n,
      'new incarnation must not inherit the retired actor linear memory');
    assert.equal(await right.send(1n), 10n);
    await fresh.stop();
    await assert.rejects(fresh.send(1n), /not accepting/);
    await right.stop();
    assert.equal(pool.actorCount, 0);
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


test('stop drains already admitted DATA before teardown and seals new admission', async () => {
  const wasm = compile();
  const pool = new PooledWasmActors({workers: 1, mailboxCapacity: 2});
  try {
    const actor = await pool.spawn(wasm, {expectedSha256: pin(wasm), trusted: true});
    const first = actor.send(3n), second = actor.send(5n);
    const stop = actor.stop();
    await assert.rejects(actor.send(2n), /not accepting/);
    assert.deepEqual(await Promise.all([first, second]), [3n, 8n]);
    await stop;
    assert.equal(pool.actorCount, 0);
  } finally {await pool.close();}
});

test('explicit pool close does not acknowledge pending guest work before termination', async () => {
  const wasm = compile({spin: true});
  const pool = new PooledWasmActors({workers: 1, timeoutMs: 3000});
  const actor = await pool.spawn(wasm, {expectedSha256: pin(wasm), trusted: true});
  const pending = actor.send(2n);
  await pool.close();
  await assert.rejects(pending, /actor pool closed/);
  assert.equal(pool.actorCount, 0);
  await assert.rejects(actor.send(4n), /not accepting/);
});

test('synchronous carrier termination fault retains actor identity and fails close', async () => {
  const {Worker} = await import('node:worker_threads');
  const wasm = compile();
  const pool = new PooledWasmActors({workers: 1});
  const actor = await pool.spawn(wasm, {trusted: true, expectedSha256: pin(wasm)});
  assert.equal(await actor.send(1n), 1n);
  const original = Worker.prototype.terminate;
  let held;
  try {
    Worker.prototype.terminate = function () {
      held = this;
      throw Error('injected synchronous termination fault');
    };
    await assert.rejects(pool.close(), /carrier termination unconfirmed/);
    assert.equal(pool.actorCount, 1, 'unconfirmed actor lease must not be released');
    await assert.rejects(actor.send(1n), /not accepting/);
  } finally {
    Worker.prototype.terminate = original;
    if (held) await original.call(held);
  }
});

test('void carrier termination receipt does not release an actor lease', async () => {
  const {Worker} = await import('node:worker_threads');
  const wasm = compile();
  const pool = new PooledWasmActors({workers: 1});
  await pool.spawn(wasm, {trusted: true, expectedSha256: pin(wasm)});
  const original = Worker.prototype.terminate;
  let held;
  try {
    Worker.prototype.terminate = function () {held = this; return undefined;};
    await assert.rejects(pool.close(), /carrier termination unconfirmed/);
    assert.equal(pool.actorCount, 1);
  } finally {
    Worker.prototype.terminate = original;
    if (held) await original.call(held);
  }
});

test('invalid actor admission preserves existing healthy actors on shared carriers', async () => {
  const good = compile(), malformed = compile({invalidImport: true});
  const pool = new PooledWasmActors({workers: 1, maxActors: 3});
  try {
    const healthy = await pool.spawn(good, {trusted: true, expectedSha256: pin(good)});
    assert.equal(await healthy.send(3n), 3n);
    await assert.rejects(pool.spawn(malformed, {trusted: true,
      expectedSha256: pin(malformed)}), /host imports denied/);
    assert.equal(pool.actorCount, 1);
    assert.equal(await healthy.send(4n), 7n);
    const next = await pool.spawn(good, {trusted: true, expectedSha256: pin(good)});
    assert.equal(await next.send(1n), 1n);
    await healthy.stop();
    await next.stop();
  } finally {await pool.close();}
});

test('one noncooperating carrier fails without terminating healthy actors on a second carrier', async () => {
  const stalled = compile({spin: true}), good = compile();
  const pool = new PooledWasmActors({workers: 2, timeoutMs: 250});
  try {
    const stuck = await pool.spawn(stalled, {trusted: true, expectedSha256: pin(stalled)});
    const healthy = await pool.spawn(good, {trusted: true, expectedSha256: pin(good)});
    const colocated = await pool.spawn(good, {trusted: true, expectedSha256: pin(good)});
    assert.equal(pool.activeWorkerCount, 2);
    const stuckWork = stuck.send(1n);
    const queuedColocated = colocated.send(1n);
    assert.equal(await healthy.send(2n), 2n);
    await assert.rejects(stuckWork, /deadline exceeded/);
    await assert.rejects(queuedColocated, /deadline exceeded/);
    assert.equal(pool.activeWorkerCount, 1);
    assert.equal(pool.actorCount, 1);
    assert.equal(await healthy.send(3n), 5n);
    const successor = await pool.spawn(good, {trusted: true, expectedSha256: pin(good)});
    assert.equal(await successor.send(9n), 9n);
    await healthy.stop();
    await successor.stop();
  } finally {await pool.close();}
});

test('failed carrier cannot settle admitted work before delayed physical termination receipt', async () => {
  const {Worker} = await import('node:worker_threads');
  const stalled = compile({spin: true}), good = compile();
  const pool = new PooledWasmActors({workers: 2, timeoutMs: 250});
  const stuck = await pool.spawn(stalled, {trusted: true, expectedSha256: pin(stalled)});
  const healthy = await pool.spawn(good, {trusted: true, expectedSha256: pin(good)});
  const original = Worker.prototype.terminate;
  let release, signal;
  const physicallyTerminated = new Promise(resolve => {signal = resolve;});
  try {
    Worker.prototype.terminate = function () {
      return original.call(this).then(code => new Promise(resolve => {
        release = () => resolve(code);
        signal();
      }));
    };
    let settled = false;
    const pending = stuck.send(1n);
    pending.catch(() => {settled = true;});
    await physicallyTerminated;
    assert.equal(settled, false, 'receipt withheld: admitted work must remain unsettled');
    assert.equal(pool.actorCount, 2, 'failed actor lease must remain pinned');
    assert.equal(await healthy.send(3n), 3n, 'healthy carrier remains available');
    assert.equal(settled, false);
    release();
    await assert.rejects(pending, /deadline exceeded/);
    assert.equal(pool.actorCount, 1);
    await healthy.stop();
  } finally {
    Worker.prototype.terminate = original;
    if (release) release();
    await pool.close();
  }
});
