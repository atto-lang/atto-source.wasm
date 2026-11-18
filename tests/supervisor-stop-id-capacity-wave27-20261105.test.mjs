// Host STOP ledger oracle; not guest CONTROL ABI or Wasmtime execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {SupervisorStopLedger} from '../src/supervisor-stop-ledger.mjs';

const make=(capacity=2)=>new SupervisorStopLedger({supervisor:'sup',group:'team',capacity});

test('repeated physical generation is denied even across terminal acknowledgement',()=>{
  const ledger=make();
  const first=ledger.register({actorId:'same',incarnation:1});
  assert.throws(()=>ledger.register({actorId:'same',incarnation:1}),/duplicate physical/);
  const second=ledger.register({actorId:'same',incarnation:2});
  assert.equal(ledger.snapshot(first).phase,'active');
  assert.throws(()=>ledger.register({actorId:'third',incarnation:1}),/capacity/);
  ledger.assert_physically_finalized(first);
  const ticket=ledger.reserve_stop(first);
  ledger.claim_host_invocation(ticket);
  ledger.mark_applied(ticket);
  ledger.acknowledge_applied(ticket);
  assert.equal(ledger.snapshot(first).phase,'stopped');
  assert.equal(ledger.snapshot(second).phase,'active');
  assert.throws(()=>ledger.receipt(ticket),/stale STOP receipt/);
  assert.throws(()=>ledger.register({actorId:'same',incarnation:1}),/capacity/);
});

test('byte-length limits reject Unicode aliases and malformed surrogate identities',()=>{
  const max=make(1);
  const child=max.register({actorId:'é'.repeat(64),incarnation:1});
  assert.equal(max.snapshot(child).actorId,'é'.repeat(64));
  for(const bad of ['é'.repeat(65),'bad\uD800','bad\uDC00','a\nb','a\u202E']) {
    const fresh=make(1);
    assert.throws(()=>fresh.register({actorId:bad,incarnation:1}),/invalid physical/);
  }
  const ok=make(1).register({actorId:'🐟'.repeat(32),incarnation:1});
  assert.equal(typeof ok,'object');
});

test('physical generation must be safe positive integer before capacity accounting',()=>{
  const lane=make(1);
  for(const incarnation of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1]) {
    assert.throws(()=>lane.register({actorId:'child',incarnation}),/invalid physical/);
  }
  assert.equal(lane.snapshot(lane.register({actorId:'child',incarnation:1})).phase,'active');
});