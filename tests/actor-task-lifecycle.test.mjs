import test from 'node:test';
import assert from 'node:assert/strict';
import {ActorTaskLedger} from '../src/actor-task-lifecycle.mjs';

test('nested tasks remain owned after parent result settles, including cancellation', () => {
  const ledger = new ActorTaskLedger({capacity: 8});
  const parent = ledger.admit();
  ledger.startOrResume(parent);
  const child = ledger.admit(parent);
  ledger.completeTurn(parent);
  assert.throws(() => ledger.retire(parent), /nested task/);
  ledger.requestCancel(parent);
  assert.equal(ledger.stage(parent), 'done');
  assert.equal(ledger.isCancellationRequested(child), true);
  assert.throws(() => ledger.startOrResume(child), /cancelled/);
  ledger.cleanupCancelled(child);
  ledger.retire(child);
  ledger.retire(parent);
  assert.equal(ledger.isQuiescent(), true);
});

test('STOP during suspension denies late Future resume until explicit cleanup and retire', () => {
  const ledger = new ActorTaskLedger();
  const token = ledger.admit();
  ledger.startOrResume(token);
  ledger.suspend(token);
  ledger.stop();
  assert.throws(() => ledger.startOrResume(token), /stopped/);
  assert.throws(() => ledger.admit(), /stopped/);
  assert.equal(ledger.isQuiescent(), false);
  ledger.cleanupCancelled(token);
  assert.equal(ledger.isQuiescent(), false);
  ledger.retire(token);
  assert.equal(ledger.isQuiescent(), true);
});

test('STOP cannot physically retire a still-running actor callback', () => {
  const ledger = new ActorTaskLedger();
  const token = ledger.admit();
  ledger.startOrResume(token);
  ledger.stop();
  assert.throws(() => ledger.cleanupCancelled(token), /quiescence not proven/);
  assert.throws(() => ledger.retire(token), /quiescence not proven/);
  ledger.completeTurn(token);
  ledger.retire(token);
  assert.equal(ledger.outstanding, 0);
});

test('opaque task identity, quota and stale foreign tokens fail closed', () => {
  const a = new ActorTaskLedger({capacity: 1});
  const b = new ActorTaskLedger({capacity: 1});
  const token = a.admit();
  assert.throws(() => a.admit(), /quota/);
  assert.throws(() => b.startOrResume(token), /foreign or stale/);
  assert.throws(() => a.startOrResume(Object.freeze({})), /foreign or stale/);
  assert.throws(() => a.admit(Object.freeze({})), /foreign or stale|quota/);
  a.startOrResume(token);
  a.completeTurn(token);
  a.retire(token);
  assert.throws(() => a.startOrResume(token), /foreign or stale/);
  assert.equal(a.isQuiescent(), true);
  assert.doesNotThrow(() => a.admit());
});

test('cancellation of one root does not cancel sibling task', () => {
  const l = new ActorTaskLedger();
  const left = l.admit(), right = l.admit();
  l.requestCancel(left);
  assert.equal(l.isCancellationRequested(left), true);
  assert.equal(l.isCancellationRequested(right), false);
  l.cleanupCancelled(left);
  l.retire(left);
  l.startOrResume(right);
  l.completeTurn(right);
  l.retire(right);
  assert.equal(l.isQuiescent(), true);
});

test('logical concurrency yields its physical actor lease before another task starts', () => {
  const l = new ActorTaskLedger();
  const a = l.admit(), b = l.admit();
  l.startOrResume(a);
  assert.throws(() => l.startOrResume(b), /actor turn busy/);
  l.suspend(a);
  l.startOrResume(b);
  assert.throws(() => l.startOrResume(a), /actor turn busy/);
  l.completeTurn(b);
  l.retire(b);
  l.startOrResume(a);
  l.completeTurn(a);
  l.retire(a);
  assert.equal(l.isQuiescent(), true);
});
