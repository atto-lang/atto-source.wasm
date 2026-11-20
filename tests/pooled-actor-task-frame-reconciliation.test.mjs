import test from 'node:test';
import assert from 'node:assert/strict';
import {ActorTaskLedger} from '../src/actor-task-lifecycle.mjs';
import {makeActorTaskReceipt, assertActorTaskReceipt} from '../src/actor-task-quiescence.mjs';
import {makeActorFrameReceipt, assertActorFrameReceipt} from '../src/actor-frame-quiescence.mjs';

// Live task cancellation is not physical task retirement. STOP is an AND-gate
// across task ledger, private frame ledger, and guest-memory scrub.
test('empty initialized actor can acknowledge INIT/SEND then STOP only after stopped', () => {
  const ledger = new ActorTaskLedger();
  assertActorTaskReceipt(makeActorTaskReceipt(ledger, 'init'), 'init');
  assertActorTaskReceipt(makeActorTaskReceipt(ledger, 'send'), 'send');
  assert.throws(() => makeActorTaskReceipt(ledger, 'stop'), /physical quiescence/);
  ledger.stop();
  assert.equal(ledger.stopped, true);
  assert.throws(() => makeActorTaskReceipt(ledger, 'send'), /physical quiescence/);
  const receipt = makeActorTaskReceipt(ledger, 'stop');
  assertActorTaskReceipt(receipt, 'stop');
  assertActorFrameReceipt(makeActorFrameReceipt(true), 'stop');
  assert.throws(() => ledger.admit(), /stopped/);
});

test('running or suspended cancelled task never mints STOP acknowledgment', () => {
  const running = new ActorTaskLedger();
  const task = running.admit();
  running.startOrResume(task);
  running.stop();
  assert.equal(running.isCancellationRequested(task), true);
  assert.throws(() => makeActorTaskReceipt(running, 'stop'), /physical quiescence/);
  assert.throws(() => running.cleanupCancelled(task), /physical task quiescence/);
  running.completeTurn(task); // real physical guest turn returned
  assert.throws(() => makeActorTaskReceipt(running, 'stop'), /physical quiescence/);
  running.retire(task);
  assertActorTaskReceipt(makeActorTaskReceipt(running, 'stop'), 'stop');

  const suspended = new ActorTaskLedger();
  const s = suspended.admit();
  suspended.startOrResume(s);
  const ticket = suspended.suspend(s);
  suspended.confirmSuspendedTurnReturned(s, ticket);
  suspended.stop();
  assert.throws(() => suspended.resumeFromWake(s, ticket), /cancelled or stopped/);
  assert.throws(() => makeActorTaskReceipt(suspended, 'stop'), /physical quiescence/);
  suspended.cleanupCancelled(s);
  suspended.retire(s);
  assertActorTaskReceipt(makeActorTaskReceipt(suspended, 'stop'), 'stop');
});

test('nested task must be physically retired before parent and STOP', () => {
  const ledger = new ActorTaskLedger();
  const p = ledger.admit();
  ledger.startOrResume(p);
  const c = ledger.admit(p);
  ledger.completeTurn(p);
  ledger.stop();
  assert.throws(() => ledger.retire(p), /nested task/);
  assert.throws(() => makeActorTaskReceipt(ledger, 'stop'), /physical quiescence/);
  ledger.cleanupCancelled(c);
  ledger.retire(c);
  ledger.retire(p);
  assert.equal(ledger.outstanding, 0);
  assertActorTaskReceipt(makeActorTaskReceipt(ledger, 'stop'), 'stop');
});

test('stale WAKE, forged task receipt, accessor and proxy are rejected', () => {
  const ledger = new ActorTaskLedger();
  const t = ledger.admit();
  ledger.startOrResume(t);
  const old = ledger.suspend(t);
  ledger.confirmSuspendedTurnReturned(t, old);
  ledger.resumeFromWake(t, old);
  assert.throws(() => ledger.resumeFromWake(t, old), /ticket/);
  const next = ledger.suspend(t);
  assert.notEqual(next, old);
  assert.throws(() => ledger.confirmSuspendedTurnReturned(t, old), /stale/);
  ledger.confirmSuspendedTurnReturned(t, next);
  ledger.stop();
  ledger.cleanupCancelled(t);
  ledger.retire(t);

  const good = makeActorTaskReceipt(ledger, 'stop');
  for (const field of Object.keys(good)) {
    const missing = {...good};
    delete missing[field];
    assert.throws(() => assertActorTaskReceipt(missing, 'stop'), /receipt/);
    const accessor = {...good};
    Object.defineProperty(accessor, field, {get() {throw Error('getter invoked');}});
    assert.throws(() => assertActorTaskReceipt(accessor, 'stop'), /receipt/);
  }
  for (const [key, value] of [
    ['schemaVersion', 2], ['authority', 'fake'], ['outstanding', 1], ['stopped', false]
  ]) assert.throws(() => assertActorTaskReceipt({...good, [key]:value}, 'stop'), /receipt/);
  assert.throws(() => assertActorTaskReceipt({...good, extra: true}, 'stop'), /receipt/);
  assert.throws(() => assertActorTaskReceipt(new Proxy({...good}, {}), 'stop'), /receipt/);
  assert.throws(() => assertActorTaskReceipt(null, 'stop'), /receipt/);
  assert.throws(() => assertActorTaskReceipt(good, 'send'), /receipt/);
  assert.throws(() => assertActorTaskReceipt(good, 'wake'), /operation/);
  assert.throws(() => makeActorTaskReceipt({}, 'stop'), /authority/);
});

test('no leak on rapid task admission/retirement and cross-ledger token denial', () => {
  const a = new ActorTaskLedger({capacity:8});
  const b = new ActorTaskLedger({capacity:8});
  for (let i=0; i<512; i++) {
    const token = a.admit();
    assert.throws(() => b.startOrResume(token), /foreign or stale/);
    a.startOrResume(token);
    a.completeTurn(token);
    a.retire(token);
    assert.equal(a.outstanding, 0);
  }
  const tokens = Array.from({length:8}, () => a.admit());
  assert.throws(() => a.admit(), /quota/);
  a.stop();
  for (const token of tokens) {
    a.cleanupCancelled(token);
    a.retire(token);
  }
  assertActorTaskReceipt(makeActorTaskReceipt(a, 'stop'), 'stop');
});
