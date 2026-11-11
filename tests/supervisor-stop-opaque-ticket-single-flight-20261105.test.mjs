import test from 'node:test';
import assert from 'node:assert/strict';
import {SupervisorStopLedger} from '../src/supervisor-stop-ledger.mjs';

test('one supervisor CONTROL turn owns at most one STOP ticket', () => {
  const ledger=new SupervisorStopLedger({supervisor:'s',group:'g',capacity:2});
  const a=ledger.register({actorId:'a',incarnation:1});
  const b=ledger.register({actorId:'b',incarnation:1});
  ledger.assert_physically_finalized(a);
  ledger.assert_physically_finalized(b);
  const first=ledger.reserve_stop(a);
  assert.throws(()=>ledger.reserve_stop(b),/already active/);
  assert.equal(ledger.receipt(first),'pending');
  ledger.claim_host_invocation(first);
  ledger.mark_applied(first);
  ledger.acknowledge_applied(first);
  assert.equal(ledger.snapshot(a).phase,'stopped');
  const second=ledger.reserve_stop(b);
  assert.notStrictEqual(second,first);
  ledger.claim_host_invocation(second);
  ledger.mark_applied(second);
  ledger.acknowledge_applied(second);
  assert.equal(ledger.snapshot(b).phase,'stopped');
  assert.throws(()=>ledger.receipt(first),/foreign, replayed or stale/);
});

test('unconfirmed host effects cannot self-acknowledge or downgrade', () => {
  const ledger=new SupervisorStopLedger({supervisor:'s',group:'g'});
  const child=ledger.register({actorId:'x',incarnation:1});
  ledger.assert_physically_finalized(child);
  const ticket=ledger.reserve_stop(child);
  assert.throws(()=>ledger.mark_uncertain(ticket),/not invoked/);
  assert.throws(()=>ledger.acknowledge_applied(ticket),/not confirmed applied/);
  ledger.claim_host_invocation(ticket);
  assert.throws(()=>ledger.claim_host_invocation(ticket),/already invoked/);
  ledger.mark_applied(ticket);
  assert.throws(()=>ledger.mark_uncertain(ticket),/cannot downgrade/);
  ledger.acknowledge_applied(ticket);
  assert.throws(()=>ledger.acknowledge_applied(ticket),/foreign, replayed or stale/);
});

test('foreign and cloned child/ticket identities never cross ledgers', () => {
  const owner=new SupervisorStopLedger({supervisor:'s',group:'g'});
  const foreign=new SupervisorStopLedger({supervisor:'s',group:'g'});
  const child=owner.register({actorId:'x',incarnation:1});
  owner.assert_physically_finalized(child);
  const ticket=owner.reserve_stop(child);
  for(const invalid of [child,structuredClone(child),Object.freeze({})])
    assert.throws(()=>foreign.snapshot(invalid),/foreign or stale/);
  for(const invalid of [ticket,structuredClone(ticket),Object.freeze({})])
    assert.throws(()=>foreign.receipt(invalid),/foreign, replayed or stale/);
  assert.equal(owner.receipt(ticket),'pending');
});

test('UTF-8 physical IDs and incarnation generations are canonical and bounded', () => {
  for(const actorId of ['\ud800','\udc00','\u200b','🚀'.repeat(33)])
    assert.throws(()=>new SupervisorStopLedger({supervisor:'s',group:'g'})
      .register({actorId,incarnation:1}),/invalid physical actor/);
  const ledger=new SupervisorStopLedger({supervisor:'s',group:'g'});
  ledger.register({actorId:'a'.repeat(128),incarnation:1});
  assert.throws(()=>ledger.register({actorId:'a'.repeat(128),incarnation:1}),/duplicate physical/);
  assert.doesNotThrow(()=>ledger.register({actorId:'a'.repeat(128),incarnation:2}));
  for(const incarnation of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1])
    assert.throws(()=>ledger.register({actorId:'valid',incarnation}),/invalid physical actor/);
});
