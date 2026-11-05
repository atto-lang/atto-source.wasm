import test from 'node:test';
import assert from 'node:assert/strict';
import {SupervisorStopLedger} from '../src/supervisor-stop-ledger.mjs';

test('STOP ticket can only follow physical finalization and a host-confirmed effect',()=>{
 const ledger=new SupervisorStopLedger({supervisor:'sup',group:'group',capacity:1});
 const child=ledger.register({actorId:'child',incarnation:1});
 assert.equal(ledger.snapshot(child).phase,'active');
 assert.throws(()=>ledger.reserve_stop(child),/physically finalized/);
 ledger.assert_physically_finalized(child);
 const ticket=ledger.reserve_stop(child);
 assert.equal(ledger.receipt(ticket),'pending');
 assert.throws(()=>ledger.acknowledge_applied(ticket),/not confirmed applied/);
 ledger.claim_host_invocation(ticket);
 ledger.mark_applied(ticket);
 assert.equal(ledger.receipt_snapshot(ticket).receipt,'applied');
 ledger.acknowledge_applied(ticket);
 assert.equal(ledger.snapshot(child).phase,'stopped');
 assert.throws(()=>ledger.receipt(ticket),/foreign, replayed or stale STOP receipt/);
});

test('opaque STOP authority cannot be imported into a different supervisor ledger',()=>{
 const origin=new SupervisorStopLedger({supervisor:'original',group:'g'});
 const other=new SupervisorStopLedger({supervisor:'different',group:'g'});
 const child=origin.register({actorId:'a',incarnation:1});
 origin.assert_physically_finalized(child);
 const ticket=origin.reserve_stop(child);
 assert.throws(()=>other.snapshot(child),/foreign or stale supervisor child authority/);
 assert.throws(()=>other.receipt(ticket),/foreign, replayed or stale STOP receipt/);
});

test('uncertain STOP may be classified twice but only trusted reconciliation closes it',()=>{
 const ledger=new SupervisorStopLedger({supervisor:'sup',group:'g'});
 const child=ledger.register({actorId:'a',incarnation:1});
 ledger.assert_physically_finalized(child);
 const ticket=ledger.reserve_stop(child);
 ledger.claim_host_invocation(ticket);
 ledger.mark_uncertain(ticket);
 ledger.mark_uncertain(ticket);
 assert.equal(ledger.receipt(ticket),'uncertain');
 assert.throws(()=>ledger.acknowledge_applied(ticket),/not confirmed applied/);
 ledger.reconcile_verified_stop(ticket);
 assert.equal(ledger.snapshot(child).phase,'stopped');
 assert.throws(()=>ledger.reconcile_verified_stop(ticket),/foreign, replayed or stale STOP receipt/);
});
