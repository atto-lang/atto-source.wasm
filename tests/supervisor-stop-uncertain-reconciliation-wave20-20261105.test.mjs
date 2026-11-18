// Host supervisor CONTROL-ledger oracle only, not a guest STOP ABI.
import test from 'node:test';
import assert from 'node:assert/strict';
import {SupervisorStopLedger} from '../src/supervisor-stop-ledger.mjs';

const make=()=>new SupervisorStopLedger({supervisor:'super',group:'grp',capacity:4});

test('an uncertain STOP blocks all other children until trusted reconciliation',()=>{
 const lane=make();
 const a=lane.register({actorId:'a',incarnation:1});
 const b=lane.register({actorId:'b',incarnation:1});
 lane.assert_physically_finalized(a);
 lane.assert_physically_finalized(b);
 const ticket=lane.reserve_stop(a);
 lane.claim_host_invocation(ticket);
 lane.mark_uncertain(ticket);
 assert.equal(lane.receipt(ticket),'uncertain');
 assert.throws(()=>lane.reserve_stop(b),/CONTROL turn already active/);
 assert.throws(()=>lane.acknowledge_applied(ticket),/not confirmed applied/);
 assert.equal(lane.snapshot(a).phase,'stopping');
 const receipt=lane.receipt_snapshot(ticket);
 assert.equal(Object.isFrozen(receipt),true);
 assert.throws(()=>lane.reconcile_verified_stop({...ticket}),/foreign/);
 lane.reconcile_verified_stop(ticket);
 assert.equal(lane.snapshot(a).phase,'stopped');
 assert.throws(()=>lane.receipt(ticket),/foreign/);
 const next=lane.reserve_stop(b);
 assert.equal(lane.receipt_snapshot(next).turnGeneration,receipt.turnGeneration+1);
 lane.claim_host_invocation(next);
 lane.mark_applied(next);
 lane.acknowledge_applied(next);
 assert.equal(lane.snapshot(b).phase,'stopped');
});

test('confirmed STOP cannot downgrade to uncertain or be replayed',()=>{
 const lane=make();
 const child=lane.register({actorId:'x',incarnation:9});
 lane.assert_physically_finalized(child);
 const ticket=lane.reserve_stop(child);
 assert.throws(()=>lane.mark_uncertain(ticket),/not invoked/);
 assert.throws(()=>lane.mark_applied(ticket),/not invoked/);
 lane.claim_host_invocation(ticket);
 lane.mark_applied(ticket);
 assert.throws(()=>lane.mark_uncertain(ticket),/downgrade/);
 assert.equal(lane.receipt(ticket),'applied');
 lane.acknowledge_applied(ticket);
 assert.throws(()=>lane.acknowledge_applied(ticket),/foreign/);
 assert.throws(()=>lane.assert_physically_finalized(child),/duplicate/);
});

test('actor identity generation and opaque handle authority stay ledger-local',()=>{
 const a=make(),b=make();
 const first=a.register({actorId:'name',incarnation:3});
 assert.throws(()=>a.register({actorId:'name',incarnation:3}),/duplicate physical/);
 const next=a.register({actorId:'name',incarnation:4});
 assert.equal(a.snapshot(next).incarnation,4);
 const outsider=b.register({actorId:'name',incarnation:3});
 assert.throws(()=>a.snapshot(outsider),/foreign/);
 assert.throws(()=>a.snapshot({...first}),/foreign/);
 for(const bad of ['x\ud800','x\u202e','a'.repeat(129)])
  assert.throws(()=>a.register({actorId:bad,incarnation:1}),/invalid physical actor identity/);
 assert.equal(a.snapshot(first).phase,'active');
 assert.equal(Object.isFrozen(first),true);
});
