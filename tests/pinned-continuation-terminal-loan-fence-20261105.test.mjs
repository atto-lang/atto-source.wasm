import test from 'node:test';
import assert from 'node:assert/strict';
import {PinnedContinuationGate} from '../src/pinned-continuation-gate.mjs';

const ticket=()=>({actorId:11,generation:12,operationId:13});
test('terminal handoff cannot retire while shared receipts remain live',()=>{
  const g=new PinnedContinuationGate(ticket());
  const a=g.acquire(ticket(),21,'shared');
  const b=g.acquire(ticket(),22,'shared');
  assert.ok(a);assert.ok(b);
  assert.equal(g.acquire(ticket(),23,'exclusive'),null);
  assert.equal(g.settle(ticket(),'timed_out'),true);
  assert.equal(g.acquire(ticket(),24,'shared'),null);
  assert.equal(g.brokerAcknowledge(ticket()),true);
  assert.equal(g.claimResume(ticket()),true);
  assert.equal(g.finishResume(ticket()),true);
  assert.equal(g.tryRetire(ticket()),false);
  assert.equal(g.release(ticket(),21,a),true);
  assert.equal(g.tryRetire(ticket()),false);
  assert.equal(g.release(ticket(),22,b),true);
  assert.equal(g.tryRetire(ticket()),true);
  assert.equal(g.release(ticket(),22,b),false);
});
test('foreign receipt is not valid in independent ledger with same numeric ticket',()=>{
  const first=new PinnedContinuationGate(ticket());
  const other=new PinnedContinuationGate(ticket());
  const receipt=first.acquire(ticket(),17,'exclusive');
  assert.equal(other.release(ticket(),17,receipt),false);
  assert.equal(other.liveReceipts,0);
  assert.equal(first.liveReceipts,1);
  assert.equal(first.release(ticket(),18,receipt),false);
  assert.equal(first.release(ticket(),17,receipt),true);
});
test('ticket getter cannot execute during terminal admission',()=>{
  const g=new PinnedContinuationGate(ticket());
  const forged=ticket();let count=0;
  Object.defineProperty(forged,'actorId',{enumerable:true,get(){count++;return 11}});
  assert.equal(g.settle(forged,'success'),false);
  assert.equal(count,0);
  assert.equal(g.terminal,null);
  assert.equal(g.settle(ticket(),'success'),true);
});
