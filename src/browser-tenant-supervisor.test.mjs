import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserTenantSupervisor} from './browser-tenant-supervisor.mjs';

const manifest = () => [{name: 'reviewed-v0', sha256: 'a'.repeat(64),
  bytes: Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)}];

// Pure parent protocol tests. These deliberately do NOT prove a Wasm guest
// executed: the real Node Worker + Clang and Chromium gates are separate.
function fakeWorker({autoAck = true} = {}) {
  let instance;
  class WorkerMock {
    constructor() {instance = this; this.messages = []; this.terminated = false;}
    postMessage(message) {
      if (this.terminated) throw Error('post to terminated worker');
      this.messages.push(message);
      if (autoAck) queueMicrotask(() => this.reply(message, 'ack'));
    }
    reply(message, kind, extra = {}) {
      if (this.terminated) return;
      this.onmessage?.({data: {
        ticket: message.ticket, id: message.id,
        incarnation: message.incarnation, kind,
        result: kind === 'ack' ? (message.kind === 'send' ? message.value : null) : undefined,
        ...extra
      }});
    }
    terminate() {this.terminated = true;}
  }
  return {WorkerMock, current: () => instance};
}
function create(worker, opts = {}) {
  return new BrowserTenantSupervisor({
    workerUrl: '/reviewed/tenant-worker.mjs', WorkerClass: worker.WorkerMock,
    manifest: manifest(), deadlineMs: 1000, ...opts
  });
}

test('parent: opaque capabilities, generation fencing and independent tenant workers', async () => {
  const wa = fakeWorker(), wb = fakeWorker();
  const a = create(wa), b = create(wb);
  try {
    const old = await a.spawn(1, 'reviewed-v0');
    assert.equal(Object.keys(old).length, 0, 'ActorRef cannot disclose an ID/generation');
    assert.equal(Object.isFrozen(old), true);
    assert.equal(await a.send(old, 7n), 7n);
    assert.throws(() => b.send(old, 7n), /unknown, stale/);
    assert.throws(() => a.send(Object.freeze({id: 1, incarnation: '1'.repeat(32)}), 7n),
      /unknown, stale/);
    const other = await b.spawn(1, 'reviewed-v0');
    assert.equal(await b.send(other, 3n), 3n);
    await a.stop(old);
    assert.throws(() => a.send(old, 1n), /unknown, stale/);
    const again = await a.spawn(1, 'reviewed-v0');
    assert.equal(await a.send(again, 2n), 2n);
    assert.throws(() => a.send(old, 1n), /unknown, stale/);
    const messages = wa.current().messages.filter(x => x.kind === 'spawn');
    assert.notEqual(messages[0].incarnation, messages[1].incarnation);
  } finally {a.close(); b.close();}
  assert.equal(wa.current().terminated, true);
  assert.equal(wb.current().terminated, true);
});

test('parent: only pinned manifest artifacts may be spawned; no caller bytes in API', async () => {
  const w = fakeWorker(), supervisor = create(w);
  try {
    await assert.rejects(supervisor.spawn(1, 'unlisted'), /not in trusted application manifest/);
    await assert.rejects(supervisor.spawn(0, 'reviewed-v0'), /invalid, duplicate/);
    assert.equal(w.current().messages.length, 0);
    const ref = await supervisor.spawn(1, 'reviewed-v0');
    await assert.rejects(supervisor.spawn(1, 'reviewed-v0'), /duplicate/);
    assert.throws(() => supervisor.send(ref, () => {}), /signed i64/);
    assert.throws(() => supervisor.send(ref, 1n << 63n), /signed i64/);
    assert.equal(w.current().messages[0].trusted, true);
  } finally {supervisor.close();}
});

test('parent: actor-local fault retires only its capability, not healthy neighbor', async () => {
  const w = fakeWorker({autoAck: false}), s = create(w);
  try {
    const spawnA = s.spawn(1, 'reviewed-v0');
    w.current().reply(w.current().messages.at(-1), 'ack');
    const a = await spawnA;
    const spawnB = s.spawn(2, 'reviewed-v0');
    w.current().reply(w.current().messages.at(-1), 'ack');
    const b = await spawnB;
    const dying = s.send(a, -1n);
    w.current().reply(w.current().messages.at(-1), 'actor_fault', {code: 'WASM_UNREACHABLE_V1'});
    await assert.rejects(dying, /actor-local/);
    assert.throws(() => s.send(a, 1n), /unknown, stale/);
    const healthy = s.send(b, 5n);
    w.current().reply(w.current().messages.at(-1), 'ack');
    assert.equal(await healthy, 5n);
    assert.equal(s.closed, false);
    assert.equal(s.activeActors, 1);
  } finally {s.close();}
});

test('parent: a wrong generation receipt quarantines entire tenant', async () => {
  const w = fakeWorker({autoAck: false}), s = create(w);
  const spawning = s.spawn(3, 'reviewed-v0');
  w.current().reply(w.current().messages[0], 'ack', {incarnation: '0'.repeat(32)});
  await assert.rejects(spawning, /forged, replayed or mismatched/);
  assert.equal(s.closed, true);
  assert.equal(w.current().terminated, true);
});

test('parent: ticket replay, forged response and fatal trap cannot become success', async () => {
  const w = fakeWorker(), s = create(w);
  const ref = await s.spawn(1, 'reviewed-v0');
  const reply = w.current().messages[0];
  w.current().reply(reply, 'ack'); // Previously consumed ticket.
  assert.equal(s.closed, true);
  assert.equal(w.current().terminated, true);
  assert.throws(() => s.send(ref, 9n), /unknown, stale|Worker/);
});

test('parent: bounded pending lane and fail-closed deadline', async () => {
  const w = fakeWorker({autoAck: false}), s = create(w, {deadlineMs: 120});
  const started = s.spawn(1, 'reviewed-v0');
  w.current().reply(w.current().messages.at(-1), 'ack');
  const ref = await started;
  const unresolved = Array.from({length: 64}, () => s.send(ref, 1n).catch(x => x));
  await assert.rejects(s.send(ref, 2n), /mailbox budget exceeded/);
  assert.match(String(await unresolved[0]), /deadline expired/);
  const others = await Promise.all(unresolved);
  assert.equal(others.length, 64);
  assert.ok(others.every(e => e instanceof Error));
  assert.equal(s.closed, true);
  assert.equal(w.current().terminated, true);
});

test('parent: immutable artifact bytes are copied at manifest ingestion', async () => {
  const supplied = manifest();
  const bytes = supplied[0].bytes;
  const w = fakeWorker(), s = create(w, {manifest: supplied});
  try {
    bytes[0] = 0xff;
    const ref = await s.spawn(1, 'reviewed-v0');
    assert.equal(w.current().messages[0].bytes[0], 0);
    assert.equal(await s.send(ref, 1n), 1n);
  } finally {s.close();}
});
