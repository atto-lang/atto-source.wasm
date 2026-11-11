import test from 'node:test';
import assert from 'node:assert/strict';
import {SupervisorStopLedger} from '../src/supervisor-stop-ledger.mjs';

const make=(group='workers')=>new SupervisorStopLedger({supervisor:'root',group,capacity:2});

test('bounded Unicode byte identities preserve distinct physical children',()=>{
 const ledger=make('é'.repeat(64));
 const a=ledger.register({actorId:'😀'.repeat(32),incarnation:1});
 const b=ledger.register({actorId:'😀'.repeat(32),incarnation:2});
 assert.notEqual(a,b);
 assert.equal(ledger.snapshot(a).incarnation,1);
 assert.throws(()=>make('é'.repeat(65)),/invalid supervisor\/group/);
 assert.throws(()=>make('😀'.repeat(33)),/invalid supervisor\/group/);
 assert.throws(()=>ledger.register({actorId:'é'.repeat(65),incarnation:1}),/invalid physical actor identity/);
});

test('format controls and malformed surrogate identity cannot forge STOP ownership',()=>{
 for(const bad of ['root\u200b','root\u200d','root\ud800','root\udc00']){
  assert.throws(()=>new SupervisorStopLedger({supervisor:bad,group:'workers'}),/invalid supervisor\/group/);
  assert.throws(()=>make().register({actorId:bad,incarnation:1}),/invalid physical actor identity/);
 }
 for(const generation of [0,-1,Number.MAX_SAFE_INTEGER+1,1.5,NaN]){
  assert.throws(()=>make().register({actorId:'actor',incarnation:generation}),/invalid physical actor identity/);
 }
});

test('uncertain STOP cannot masquerade as applied or be acknowledged twice',()=>{
 const ledger=make(),child=ledger.register({actorId:'actor',incarnation:1});
 ledger.assert_physically_finalized(child);
 const ticket=ledger.reserve_stop(child);
 assert.throws(()=>ledger.acknowledge_applied(ticket),/host STOP effect not confirmed/);
 ledger.claim_host_invocation(ticket);
 ledger.mark_uncertain(ticket);
 assert.equal(ledger.receipt_snapshot(ticket).receipt,'uncertain');
 assert.throws(()=>ledger.acknowledge_applied(ticket),/host STOP effect not confirmed/);
 ledger.reconcile_verified_stop(ticket);
 assert.equal(ledger.snapshot(child).phase,'stopped');
 assert.throws(()=>ledger.receipt(ticket),/foreign, replayed or stale STOP receipt/);
 assert.throws(()=>ledger.reconcile_verified_stop(ticket),/foreign, replayed or stale STOP receipt/);
});