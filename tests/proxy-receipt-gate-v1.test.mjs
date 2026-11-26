import test from 'node:test';
import assert from 'node:assert/strict';
import {ProxyReceiptGateV1} from '../src/proxy-receipt-gate-v1.mjs';

const id = Object.freeze({protocol_major: 1, tenant: 11n,
  caller_incarnation: 12n, target_actor: 13n, target_incarnation: 14n,
  association_generation: 17n, placement_epoch: 15n, message_id: 16n, attempt: 1n});
test('proxy queue or socket dispatch is never destination admission', () => {
  const gate = new ProxyReceiptGateV1(id);
  assert.equal(gate.stage, 'dispatched');
  assert.equal(gate.destination_admitted, false);
  for (const stage of ['started', 'processed', 'durable_inbox', 'durable_result'])
    assert.equal(gate.apply_verified(id, stage), false);
});
test('cross-tenant, incarnation, epoch, attempt and protocol replay fails closed', () => {
  const gate = new ProxyReceiptGateV1(id);
  for (const field of Object.keys(id)) {
    const wrong = {...id, [field]: field === 'protocol_major' ? 2 : id[field] + 1n};
    assert.equal(gate.apply_verified(wrong, 'admitted'), false, field);
  }
  assert.equal(gate.stage, 'dispatched');
});
test('destination admission, started, processed and provider commits are distinct', () => {
  const gate = new ProxyReceiptGateV1(id);
  assert.equal(gate.apply_verified(id, 'admitted'), true);
  assert.equal(gate.destination_admitted, true);
  assert.equal(gate.apply_verified(id, 'durable_result'), false);
  assert.equal(gate.apply_verified(id, 'durable_inbox'), true);
  assert.equal(gate.durable_inbox, true);
  assert.equal(gate.stage, 'admitted');
  assert.equal(gate.apply_verified(id, 'started'), true);
  assert.equal(gate.apply_verified(id, 'admitted'), true);
  assert.equal(gate.stage, 'started');
  assert.equal(gate.apply_verified(id, 'processed'), true);
  assert.equal(gate.apply_verified(id, 'durable_result'), true);
  assert.equal(gate.durable_result, true);
  assert.equal(gate.apply_verified(id, 'indeterminate'), false);
  assert.equal(gate.apply_verified(id, 'failed'), false);
});
test('ambiguous loss cannot become rejection or be resolved by late ACK', () => {
  const gate = new ProxyReceiptGateV1(id);
  assert.equal(gate.apply_verified(id, 'indeterminate'), true);
  assert.equal(gate.outcome, 'indeterminate');
  assert.equal(gate.apply_verified(id, 'admitted'), false);
  assert.equal(gate.apply_verified(id, 'rejected'), false);
});
test('rejection only before destination admission; failure after admission', () => {
  const reject = new ProxyReceiptGateV1(id);
  assert.equal(reject.apply_verified(id, 'rejected'), true);
  assert.equal(reject.apply_verified(id, 'admitted'), false);
  const failed = new ProxyReceiptGateV1(id);
  assert.equal(failed.apply_verified(id, 'admitted'), true);
  assert.equal(failed.apply_verified(id, 'rejected'), false);
  assert.equal(failed.apply_verified(id, 'failed'), true);
  assert.equal(failed.apply_verified(id, 'processed'), false);
});
test('missing and forged identity fields fail closed', () => {
  assert.throws(() => new ProxyReceiptGateV1({...id, tenant: 0n}), /E_PROXY_IDENTITY/);
  assert.throws(() => new ProxyReceiptGateV1({...id, tenant: 1}), /E_PROXY_IDENTITY/);
  assert.throws(() => new ProxyReceiptGateV1({...id, attempt: 0n}), /E_PROXY_IDENTITY/);
  assert.throws(() => new ProxyReceiptGateV1({...id, attempt: -1n}), /E_PROXY_IDENTITY/);
  const gate = new ProxyReceiptGateV1(id);
  assert.equal(gate.apply_verified({...id, target_actor: 0n}, 'admitted'), false);
  assert.equal(gate.apply_verified(id, 'anything'), false);
  let invoked = 0;
  const hostile = {...id};
  Object.defineProperty(hostile, 'tenant', {get() {invoked++; return 11n;}});
  assert.equal(gate.apply_verified(hostile, 'admitted'), false);
  assert.equal(invoked, 0);
});
