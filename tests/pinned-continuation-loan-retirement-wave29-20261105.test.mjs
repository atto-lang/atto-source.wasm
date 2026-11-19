import test from 'node:test';
import assert from 'node:assert/strict';
import {PinnedContinuationGate} from '../src/pinned-continuation-gate.mjs';

const ticket = () => ({actorId: 31, generation: 7, operationId: 5});

// A host ledger model: this cannot attest to pinned WebAssembly guest frames.
test('exclusive loans exclude shared loans and reject wrong borrower release', () => {
  const t = ticket(), gate = new PinnedContinuationGate(t);
  const shared = gate.acquire(t, 1, 'shared');
  assert.ok(shared);
  assert.equal(gate.acquire(t, 2, 'exclusive'), null);
  assert.equal(gate.release(t, 2, shared), false);
  assert.equal(gate.release(t, 1, shared), true);
  const exclusive = gate.acquire(t, 3, 'exclusive');
  assert.ok(exclusive);
  assert.equal(gate.acquire(t, 4, 'shared'), null);
  assert.equal(gate.release(t, 3, exclusive), true);
  assert.deepEqual(gate.loanState, {shared: 0, exclusive: false});
});

test('retirement requires terminal, broker quiescence, resume and all receipt releases', () => {
  const t = ticket(), gate = new PinnedContinuationGate(t);
  const receipts = Array.from({length: 64}, (_, i) => gate.acquire(t, i + 1, 'shared'));
  assert.ok(receipts.every(Boolean));
  assert.equal(gate.acquire(t, 65, 'shared'), null);
  assert.equal(gate.tryRetire(t), false);
  assert.equal(gate.settle(t, 'cancelled'), true);
  assert.equal(gate.brokerAcknowledge(t), true);
  assert.equal(gate.claimResume(t), true);
  assert.equal(gate.finishResume(t), true);
  assert.equal(gate.tryRetire(t), false);
  for (let i = 0; i < receipts.length; i++) {
    assert.equal(gate.release(t, i + 1, receipts[i]), true);
  }
  assert.equal(gate.tryRetire(t), true);
  assert.equal(gate.tryRetire(t), false);
  assert.equal(gate.acquire(t, 66, 'shared'), null);
});

test('stale generations and accessor tickets have no authority', () => {
  const t = ticket(), gate = new PinnedContinuationGate(t);
  assert.equal(gate.settle({...t, generation: 8}, 'success'), false);
  let called = 0;
  const forged = {...t};
  Object.defineProperty(forged, 'operationId', {enumerable: true, get() { called++; return 5; }});
  assert.equal(gate.claimResume(forged), false);
  assert.equal(called, 0);
  assert.equal(gate.terminal, null);
});
