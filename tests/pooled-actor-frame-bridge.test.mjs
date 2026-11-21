import test from 'node:test';
import assert from 'node:assert/strict';
import {ActorFrameLedger} from '../src/actor-frame-ledger.mjs';
import {PooledWasmActors} from '../src/pooled-actor-host.mjs';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const incarnation = 'a'.repeat(32);
const ledger = id => new ActorFrameLedger({actorId: id, incarnation});

test('private actor frames reject foreign execution, frame and physical turn', () => {
  const a = ledger(10), b = ledger(11), ta = a.beginTurn(), tb = b.beginTurn();
  const ea = a.startExecution(ta), eb = b.startExecution(tb);
  const fa = a.pushFrame(ta, ea, 4), fb = b.pushFrame(tb, eb, 4);
  a.writeFrame(ta, ea, fa, Uint8Array.of(3, 5, 7, 9));
  b.writeFrame(tb, eb, fb, Uint8Array.of(8, 6, 4, 2));
  assert.deepEqual([...a.readFrame(ta, ea, fa)], [3, 5, 7, 9]);
  assert.deepEqual([...b.readFrame(tb, eb, fb)], [8, 6, 4, 2]);
  assert.throws(() => b.readFrame(tb, eb, fa), /foreign, stale/);
  assert.throws(() => a.readFrame(ta, eb, fb), /execution authority/);
  assert.throws(() => a.readFrame(tb, ea, fa), /turn authority/);
  a.popFrame(ta, ea, fa); b.popFrame(tb, eb, fb);
  a.finishExecution(ta, ea); b.finishExecution(tb, eb);
  a.endTurn(ta); b.endTurn(tb); a.retire(); b.retire();
});

test('LIFO frames protect caller, copy reads and scrub reissued offsets', () => {
  const a = ledger(12), t = a.beginTurn(), e = a.startExecution(t);
  const caller = a.pushFrame(t, e, 3);
  a.writeFrame(t, e, caller, Uint8Array.of(9, 8, 7));
  const callee = a.pushFrame(t, e, 3);
  assert.throws(() => a.readFrame(t, e, caller), /non-top/);
  assert.throws(() => a.popFrame(t, e, caller), /non-top/);
  a.writeFrame(t, e, callee, Uint8Array.of(2, 4, 6));
  const detachedCopy = a.readFrame(t, e, callee);
  detachedCopy.fill(0);
  assert.deepEqual([...a.readFrame(t, e, callee)], [2, 4, 6]);
  a.popFrame(t, e, callee);
  assert.throws(() => a.readFrame(t, e, callee), /stale/);
  const replacement = a.pushFrame(t, e, 3);
  assert.deepEqual([...a.readFrame(t, e, replacement)], [0, 0, 0]);
  a.popFrame(t, e, replacement);
  assert.deepEqual([...a.readFrame(t, e, caller)], [9, 8, 7]);
  a.popFrame(t, e, caller);
  a.finishExecution(t, e); a.endTurn(t); a.retire();
});

test('suspend and resume preserve frames across physical turns with one-use tickets', () => {
  const a = ledger(13), t1 = a.beginTurn(), e = a.startExecution(t1);
  const f = a.pushFrame(t1, e, 4);
  a.writeFrame(t1, e, f, Uint8Array.of(1, 3, 5, 7));
  assert.throws(() => a.endTurn(t1), /must suspend or finish/);
  const ticket = a.suspend(t1, e);
  a.endTurn(t1);
  const t2 = a.beginTurn();
  assert.throws(() => a.resume(t2, structuredClone(ticket)), /stale or consumed/);
  assert.equal(a.resume(t2, ticket), e);
  assert.deepEqual([...a.readFrame(t2, e, f)], [1, 3, 5, 7]);
  a.popFrame(t2, e, f); a.finishExecution(t2, e);
  assert.throws(() => a.resume(t2, ticket), /stale or consumed/);
  a.endTurn(t2); a.retire();
});

test('bounded eight independently suspended logical stacks and survivor', () => {
  const a = ledger(14), good = ledger(15);
  const t = a.beginTurn(), gt = good.beginTurn();
  const saved = [];
  for (let i = 0; i < 8; i++) {
    const e = a.startExecution(t), f = a.pushFrame(t, e, 1);
    a.writeFrame(t, e, f, Uint8Array.of(i));
    saved.push({e, f, ticket: a.suspend(t, e)});
  }
  assert.equal(a.liveExecutionCount, 8);
  assert.equal(a.frameBytesInUse, 8);
  assert.throws(() => a.startExecution(t), /execution quota/);
  const ge = good.startExecution(gt), gf = good.pushFrame(gt, ge, 1);
  good.writeFrame(gt, ge, gf, Uint8Array.of(42));
  assert.equal(good.readFrame(gt, ge, gf)[0], 42);
  good.popFrame(gt, ge, gf); good.finishExecution(gt, ge);
  for (const {e, f, ticket} of saved.reverse()) {
    assert.equal(a.resume(t, ticket), e);
    a.popFrame(t, e, f);
    a.finishExecution(t, e);
  }
  a.endTurn(t); good.endTurn(gt); a.retire(); good.retire();
});

test('byte budget and depth failure leave live frame bytes intact', () => {
  const a = ledger(16), t = a.beginTurn(), e = a.startExecution(t);
  const full = a.pushFrame(t, e, 65536);
  a.writeFrame(t, e, full, new Uint8Array(65536).fill(77));
  assert.throws(() => a.pushFrame(t, e, 1), /byte quota/);
  assert.equal(a.readFrame(t, e, full)[65535], 77);
  assert.throws(() => a.pushFrame(t, e, 65537), /invalid actor frame length/);
  a.popFrame(t, e, full);
  const frames = Array.from({length: 64}, () => a.pushFrame(t, e, 1));
  assert.throws(() => a.pushFrame(t, e, 1), /depth quota/);
  for (const f of frames.reverse()) a.popFrame(t, e, f);
  a.finishExecution(t, e); a.endTurn(t); a.retire();
});

test('cross-generation tokens, cancellation and physical STOP revoke all authority', () => {
  const a = ledger(17), t = a.beginTurn(), e = a.startExecution(t);
  const frame = a.pushFrame(t, e, 4);
  a.writeFrame(t, e, frame, Uint8Array.of(1, 1, 1, 1));
  const ticket = a.suspend(t, e);
  a.cancelExecution(t, e);
  assert.throws(() => a.resume(t, ticket), /stale or consumed/);
  const next = a.startExecution(t), nextFrame = a.pushFrame(t, next, 4);
  assert.deepEqual([...a.readFrame(t, next, nextFrame)], [0, 0, 0, 0]);
  assert.throws(() => a.readFrame(t, next, frame), /stale/);
  a.cancelExecution(t, next);
  a.endTurn(t); a.retire();
  assert.throws(() => a.beginTurn(), /retired/);
  const restarted = new ActorFrameLedger({actorId: 17, incarnation: 'b'.repeat(32)});
  const rt = restarted.beginTurn();
  assert.throws(() => restarted.resume(rt, ticket), /stale or consumed/);
  restarted.endTurn(rt); restarted.retire();
});

test('shared, spoofed, detached and resizable inputs never corrupt frame data', () => {
  const a = ledger(18), t = a.beginTurn(), e = a.startExecution(t);
  const f = a.pushFrame(t, e, 4);
  a.writeFrame(t, e, f, Uint8Array.of(3, 2, 1, 0));
  const forged = Object.create(Uint8Array.prototype);
  Object.defineProperty(forged, 'byteLength', {value: 4});
  assert.throws(() => a.writeFrame(t, e, f, forged), /exact-size/);
  if (typeof SharedArrayBuffer === 'function') {
    const shared = new Uint8Array(new SharedArrayBuffer(4));
    Object.defineProperty(shared, 'buffer', {value: new ArrayBuffer(4)});
    assert.throws(() => a.writeFrame(t, e, f, shared), /shared memory/);
  }
  const buf = new ArrayBuffer(4);
  const detached = new Uint8Array(buf);
  structuredClone(buf, {transfer: [buf]});
  assert.throws(() => a.writeFrame(t, e, f, detached), /exact-size/);
  assert.deepEqual([...a.readFrame(t, e, f)], [3, 2, 1, 0]);
  a.popFrame(t, e, f); a.finishExecution(t, e); a.endTurn(t); a.retire();
});

test('frame read uses owned constructors rather than mutable TypedArray species', () => {
  const a = ledger(19), t = a.beginTurn(), e = a.startExecution(t);
  const f = a.pushFrame(t, e, 4);
  a.writeFrame(t, e, f, Uint8Array.of(1, 2, 3, 4));
  const original = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'constructor');
  try {
    Object.defineProperty(Uint8Array.prototype, 'constructor', {
      configurable: true, get() { throw Error('poisoned species'); }
    });
    assert.deepEqual([...a.readFrame(t, e, f)], [1, 2, 3, 4]);
  } finally {
    if (original) Object.defineProperty(Uint8Array.prototype, 'constructor', original);
    else delete Uint8Array.prototype.constructor;
  }
  a.popFrame(t, e, f); a.finishExecution(t, e); a.endTurn(t); a.retire();
});

test('retirement refuses active physical turns and cleans suspended stacks', () => {
  const a = ledger(20), t = a.beginTurn(), e = a.startExecution(t);
  const f = a.pushFrame(t, e, 2);
  a.writeFrame(t, e, f, Uint8Array.of(8, 9));
  const ticket = a.suspend(t, e);
  assert.throws(() => a.retire(), /active actor frame turn/);
  a.endTurn(t);
  a.retire();
  assert.equal(a.retired, true);
  assert.equal(a.liveExecutionCount, 0);
  assert.equal(a.frameBytesInUse, 0);
  assert.throws(() => a.beginTurn(), /retired/);
  const b = ledger(21), bt = b.beginTurn();
  assert.throws(() => b.resume(bt, ticket), /stale or consumed/);
  b.endTurn(bt); b.retire();
});

function compileScalarFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'atto-actor-frame-'));
  const output = join(dir, 'actor.wasm');
  const ir = [
    'target triple = "wasm32-unknown-unknown"',
    '@counter = internal global i64 0',
    'define void @oreslang_wasm_actor_init() { ret void }',
    'define i64 @oreslang_wasm_actor_on_message(i64 %n) {',
    'entry:', '%v = load i64, ptr @counter',
    '%next = add i64 %v, %n', 'store i64 %next, ptr @counter',
    'ret i64 %next', '}',
    'define void @oreslang_wasm_actor_teardown() { ret void }', ''
  ].join('\n');
  const args = ['--target=wasm32', '-x', 'ir', '-O0', '-nostdlib',
    '-Wl,--no-entry', '-Wl,--export-memory',
    '-Wl,--export=oreslang_wasm_actor_init',
    '-Wl,--export=oreslang_wasm_actor_on_message',
    '-Wl,--export=oreslang_wasm_actor_teardown',
    '-Wl,--initial-memory=131072', '-Wl,--max-memory=131072',
    '-o', output, '-'];
  try {
    const c = spawnSync(process.env.CLANG || 'clang', args,
      {input: ir, encoding: 'utf8', timeout: 30000});
    if (c.error || c.status !== 0) throw Error(c.error?.message || c.stderr);
    return readFileSync(output);
  } finally {rmSync(dir, {recursive: true, force: true});}
}

test('actual pooled Worker calls now traverse per-actor managed frame leases', async () => {
  // REAL Wasm execution from synthetic LLVM IR, NOT source .atto actor codegen.
  const bytes = compileScalarFixture();
  const sha = createHash('sha256').update(bytes).digest('hex');
  const pool = new PooledWasmActors({workers: 1, maxActors: 2});
  try {
    const a = await pool.spawn(bytes, {trusted: true, expectedSha256: sha});
    const b = await pool.spawn(bytes, {trusted: true, expectedSha256: sha});
    assert.equal(await a.send(30n), 30n);
    assert.equal(await b.send(6n), 6n);
    assert.equal(await a.send(12n), 42n);
    await a.stop();
    assert.equal(await b.send(1n), 7n);
    const restarted = await pool.spawn(bytes, {trusted: true, expectedSha256: sha});
    assert.equal(await restarted.send(1n), 1n);
    await restarted.stop();
    await b.stop();
  } finally {await pool.close();}
});
