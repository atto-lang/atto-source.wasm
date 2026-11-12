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
  const ticket = l.suspend(a);
  l.startOrResume(b);
  assert.throws(() => l.resumeFromWake(a, ticket), /actor turn busy/);
  l.completeTurn(b);
  l.retire(b);
  assert.throws(() => l.startOrResume(a), /authenticated WAKE/);
  l.resumeFromWake(a, ticket);
  l.completeTurn(a);
  l.retire(a);
  assert.equal(l.isQuiescent(), true);
});

test('WAKE ticket is single-use and bound to exact suspension, task and ledger', () => {
  const first = new ActorTaskLedger(), second = new ActorTaskLedger();
  const a = first.admit(), b = first.admit(), foreign = second.admit();
  first.startOrResume(a);
  const ticket1 = first.suspend(a);
  assert.throws(() => first.startOrResume(a), /authenticated WAKE/);
  assert.throws(() => first.resumeFromWake(a, Object.freeze({})), /WAKE ticket/);
  assert.throws(() => first.resumeFromWake(b, ticket1), /WAKE ticket/);
  assert.throws(() => second.resumeFromWake(foreign, ticket1), /WAKE ticket/);
  first.resumeFromWake(a, ticket1);
  assert.throws(() => first.resumeFromWake(a, ticket1), /WAKE ticket/);
  const ticket2 = first.suspend(a);
  assert.notEqual(ticket1, ticket2);
  assert.throws(() => first.resumeFromWake(a, ticket1), /WAKE ticket/);
  first.resumeFromWake(a, ticket2);
  first.completeTurn(a);
  first.retire(a);
  first.startOrResume(b);
  first.completeTurn(b);
  first.retire(b);
  assert.equal(first.isQuiescent(), true);
});

test('nested child admission requires a physically running parent', () => {
  const l = new ActorTaskLedger();
  const parent = l.admit();
  assert.throws(() => l.admit(parent), /parent task unavailable/);
  l.startOrResume(parent);
  const child = l.admit(parent);
  assert.throws(() => l.startOrResume(child), /actor turn busy/);
  const ticket = l.suspend(parent);
  assert.throws(() => l.admit(parent), /parent task unavailable/);
  l.resumeFromWake(parent, ticket);
  l.completeTurn(parent);
  assert.throws(() => l.admit(parent), /parent task unavailable/);
  l.requestCancel(parent);
  l.cleanupCancelled(child);
  l.retire(child);
  l.retire(parent);
  assert.equal(l.isQuiescent(), true);
});

test('STOP revokes late WAKE without falsely publishing physical completion', () => {
  const l = new ActorTaskLedger();
  const task = l.admit();
  l.startOrResume(task);
  const ticket = l.suspend(task);
  l.stop();
  assert.throws(() => l.resumeFromWake(task, ticket), /stopped/);
  assert.equal(l.isQuiescent(), false);
  l.cleanupCancelled(task);
  assert.throws(() => l.resumeFromWake(task, ticket), /stopped/);
  l.retire(task);
  assert.equal(l.isQuiescent(), true);
});

test('separate actor ledgers can run independent mutable turns concurrently', () => {
  const first = new ActorTaskLedger(), second = new ActorTaskLedger();
  const a = first.admit(), b = second.admit();
  first.startOrResume(a);
  assert.doesNotThrow(() => second.startOrResume(b));
  assert.equal(first.stage(a), 'running');
  assert.equal(second.stage(b), 'running');
  first.completeTurn(a);
  second.completeTurn(b);
  first.retire(a);
  second.retire(b);
  assert.equal(first.isQuiescent(), true);
  assert.equal(second.isQuiescent(), true);
});

test('bounded nested graph STOP waits for all child cleanup after parent settles', () => {
  const l = new ActorTaskLedger({capacity: 8});
  const parent = l.admit();
  l.startOrResume(parent);
  const children = Array.from({length: 7}, () => l.admit(parent));
  assert.throws(() => l.admit(parent), /quota/);
  l.completeTurn(parent);
  l.stop();
  assert.throws(() => l.retire(parent), /nested task not yet retired/);
  for (const child of children) {
    assert.equal(l.isCancellationRequested(child), true);
    l.cleanupCancelled(child);
    l.retire(child);
  }
  assert.equal(l.isQuiescent(), false);
  l.retire(parent);
  assert.equal(l.isQuiescent(), true);
  for (const child of children)
    assert.throws(() => l.startOrResume(child), /foreign or stale/);
});
