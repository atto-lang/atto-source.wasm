import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { makeTerminalEffectNotice, terminalEffectReceiver,
  EffectNoticeProtocolError } from '../runtime/terminal-effect-notice.mjs';

const base = { actor_id: 'actor:7', parent_id: 'supervisor:2', generation: 4,
  sequence: 0, effect: 'raise', error_type: 'DatabaseError', message: 'lost quorum' };
const WORKER = Object.freeze({});
const notice = (overrides = {}) => makeTerminalEffectNotice({ ...base, ...overrides });
const receiver = (worker = WORKER) => terminalEffectReceiver({ ...base, worker });

test('throw, raise, panic stay distinct and terminal on CONTROL', () => {
  for (const effect of ['throw', 'raise', 'panic']) {
    const result = receiver().accept(notice({ effect }), WORKER);
    assert.equal(result.effect, effect);
    assert.equal(result.lane, 'CONTROL');
    assert.equal(result.recoverable, false);
    assert.equal(result.terminal, true);
    assert.equal(Object.hasOwn(result, 'stack'), false);
    assert.equal(Object.hasOwn(result, 'cursor'), false);
  }
});

test('only the bound physical Worker can submit a notice', () => {
  assert.throws(() => receiver().accept(notice(), Object.freeze({})), /untrusted Worker/);
  assert.equal(receiver().accept(notice(), WORKER).effect, 'raise');
});

test('terminal notice cannot be replayed or revive a dead actor generation', () => {
  const recv = receiver();
  recv.accept(notice(), WORKER);
  assert.equal(recv.closed, true);
  assert.throws(() => recv.accept(notice(), WORKER), EffectNoticeProtocolError);
});

test('wrong actor, parent, generation or sequence is rejected', () => {
  for (const modified of [
    { actor_id: 'actor:8' }, { parent_id: 'supervisor:3' },
    { generation: 3 }, { generation: 5 }, { sequence: 1 }
  ]) assert.throws(() => receiver().accept(notice(modified), WORKER), /E_EFFECT_PROTOCOL/);
});

test('guest may not impersonate cancellation, host failure or recover', () => {
  for (const effect of ['cancel', 'host', 'timeout', 'recover', 'defer', 'success', 'unknown'])
    assert.throws(() => notice({ effect }), /invalid terminal effect/);
  for (const extra of [
    { ...notice(), recoverable: true },
    { ...notice(), cleanup_done: true },
    { ...notice(), stack: ['forged-frame'] },
    { ...notice(), type: 'atto.actor.terminal-effect.v2' },
    { ...notice(), message: '\0' },
    { ...notice(), error_type: '../Error' }
  ]) assert.throws(() => receiver().accept(extra, WORKER), /E_EFFECT_PROTOCOL/);
});

test('untrusted object shape, prototype, accessor and oversize fail closed', () => {
  assert.throws(() => receiver().accept(null, WORKER), /plain object/);
  assert.throws(() => receiver().accept(new Error('raise'), WORKER), /prototype denied/);
  assert.throws(() => receiver().accept(
    Object.assign(Object.create({ effect: 'panic' }), notice()), WORKER), /prototype denied/);
  const forged = { ...notice() };
  Object.defineProperty(forged, 'message', { enumerable: true, get() { throw new Error('getter ran'); } });
  assert.throws(() => receiver().accept(forged, WORKER), /accessor field denied/);
  assert.throws(() => notice({ message: 'x'.repeat(1025) }), /invalid message/);
});

test('real Worker structured-clone cannot transport recover callbacks', async () => {
  const worker = new Worker(new URL('./terminal-effect-worker.mjs', import.meta.url));
  try {
    const received = await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.postMessage({ actor_id: base.actor_id, parent_id: base.parent_id,
        generation: base.generation });
    });
    const result = receiver(worker).accept(received, worker);
    assert.equal(result.effect, 'raise');
    assert.equal(result.recoverable, false);
    assert.equal(result.error_type, 'DatabaseError');
    assert.equal(Object.hasOwn(received, 'recover'), false);
  } finally { await worker.terminate(); }
});
