// Host-only CONTROL receipt ledger; does not expose a guest STOP ABI.
import test from 'node:test';
import assert from 'node:assert/strict';
import {SupervisorStopLedger} from '../src/supervisor-stop-ledger.mjs';

test('physical actor IDs cannot change UTF-8 bytes or smuggle controls',()=>{
  const ledger=new SupervisorStopLedger({supervisor:'s',group:'g',capacity:3});
  for(const bad of ['\ud800','\udc00','界'.repeat(43),'\u202e','bad\u0001']){
    assert.throws(()=>ledger.register({actorId:bad,incarnation:1}),/invalid physical actor identity/);
  }
  const child=ledger.register({actorId:'actor-✅',incarnation:1});
  assert.equal(Object.isFrozen(child),true);
  assert.deepEqual(Reflect.ownKeys(child),[]);
  const snap=ledger.snapshot(child);
  assert.equal(snap.actorId,'actor-✅');
  assert.equal(Object.isFrozen(snap),true);
});

test('duplicate identities and capacity never mint extra authority',()=>{
  const ledger=new SupervisorStopLedger({supervisor:'s',group:'g',capacity:2});
  const first=ledger.register({actorId:'a',incarnation:1});
  assert.throws(()=>ledger.register({actorId:'a',incarnation:1}),/duplicate physical actor generation/);
  ledger.register({actorId:'b',incarnation:1});
  assert.throws(()=>ledger.register({actorId:'c',incarnation:1}),/capacity exhausted/);
  assert.throws(()=>ledger.reserve_stop(first),/physically finalized child/);
});

test('an uncertain STOP requires trusted reconciliation and burns its ticket',()=>{
  const ledger=new SupervisorStopLedger({supervisor:'s',group:'g'});
  const child=ledger.register({actorId:'actor',incarnation:1});
  ledger.assert_physically_finalized(child);
  const ticket=ledger.reserve_stop(child);
  assert.throws(()=>ledger.mark_applied(ticket),/not invoked/);
  ledger.claim_host_invocation(ticket);
  ledger.mark_uncertain(ticket);
  const snapshot=ledger.receipt_snapshot(ticket);
  assert.equal(snapshot.receipt,'uncertain');
  assert.equal(Object.isFrozen(snapshot),true);
  assert.throws(()=>ledger.acknowledge_applied(ticket),/not confirmed applied/);
  ledger.reconcile_verified_stop(ticket);
  assert.equal(ledger.snapshot(child).phase,'stopped');
  assert.throws(()=>ledger.receipt(ticket),/stale STOP receipt/);
});
