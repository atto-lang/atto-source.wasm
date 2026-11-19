import test from 'node:test';
import assert from 'node:assert/strict';
import {SupervisorStopLedger} from '../src/supervisor-stop-ledger.mjs';

const make=()=>new SupervisorStopLedger({supervisor:'root',group:'workers',capacity:2});
test('STOP requires physical finalization and applied effect before acknowledgement',()=>{
 const ledger=make(),child=ledger.register({actorId:'one',incarnation:1});
 assert.throws(()=>ledger.reserve_stop(child),/physically finalized child/);
 ledger.assert_physically_finalized(child);
 const ticket=ledger.reserve_stop(child);
 assert.equal(ledger.receipt(ticket),'pending');
 assert.throws(()=>ledger.mark_applied(ticket),/STOP not invoked/);
 ledger.claim_host_invocation(ticket);
 assert.throws(()=>ledger.acknowledge_applied(ticket),/not confirmed applied/);
 ledger.mark_applied(ticket);
 assert.equal(ledger.receipt_snapshot(ticket).receipt,'applied');
 ledger.acknowledge_applied(ticket);
 assert.equal(ledger.snapshot(child).phase,'stopped');
 assert.throws(()=>ledger.receipt(ticket),/foreign, replayed or stale STOP receipt/);
});
test('single CONTROL ticket excludes concurrent stops and replayed receipts',()=>{
 const ledger=make(),a=ledger.register({actorId:'a',incarnation:1}),b=ledger.register({actorId:'b',incarnation:1});
 ledger.assert_physically_finalized(a);ledger.assert_physically_finalized(b);
 const first=ledger.reserve_stop(a);
 assert.throws(()=>ledger.reserve_stop(b),/CONTROL turn already active/);
 ledger.claim_host_invocation(first);ledger.mark_uncertain(first);
 assert.equal(ledger.receipt_snapshot(first).receipt,'uncertain');
 ledger.reconcile_verified_stop(first);
 const second=ledger.reserve_stop(b);
 assert.notEqual(first,second);
 assert.throws(()=>ledger.claim_host_invocation(first),/foreign, replayed or stale STOP receipt/);
});
test('physical actor generations and opaque identities cannot be reused or forged',()=>{
 const ledger=make(),child=ledger.register({actorId:'same',incarnation:1});
 assert.equal(Object.getPrototypeOf(child),null);
 assert.equal(Object.isFrozen(child),true);
 assert.throws(()=>ledger.snapshot({}),/foreign or stale supervisor child authority/);
 assert.throws(()=>ledger.register({actorId:'same',incarnation:1}),/duplicate physical actor generation/);
 ledger.register({actorId:'same',incarnation:2});
 assert.throws(()=>ledger.register({actorId:'new',incarnation:1}),/capacity exhausted/);
});