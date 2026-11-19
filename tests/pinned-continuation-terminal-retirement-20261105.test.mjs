import test from 'node:test';
import assert from 'node:assert/strict';
import {PinnedContinuationGate} from '../src/pinned-continuation-gate.mjs';

const ticket=()=>({actorId:1,generation:2,operationId:3});

test('two shared loans block exclusive ownership until released',()=>{
  const id=ticket(),gate=new PinnedContinuationGate(id);
  const first=gate.acquire(id,10,'shared');
  const second=gate.acquire(id,11,'shared');
  assert.ok(first);
  assert.ok(second);
  assert.equal(gate.loanState.shared,2);
  assert.equal(gate.acquire(id,12,'exclusive'),null);
  assert.equal(gate.release(id,10,first),true);
  assert.equal(gate.release(id,11,second),true);
  const exclusive=gate.acquire(id,12,'exclusive');
  assert.ok(exclusive);
  assert.equal(gate.loanState.exclusive,true);
  assert.equal(gate.release(id,12,exclusive),true);
});

test('terminal settlement and broker acknowledgement are single-flight transitions',()=>{
  const id=ticket(),gate=new PinnedContinuationGate(id);
  assert.equal(gate.claimResume(id),false);
  assert.equal(gate.settle(id,'success'),true);
  assert.equal(gate.settle(id,'failure'),false);
  assert.equal(gate.brokerAcknowledge(id),true);
  assert.equal(gate.brokerAcknowledge(id),false);
  assert.equal(gate.claimResume(id),true);
  assert.equal(gate.claimResume(id),false);
  assert.equal(gate.finishResume(id),true);
  assert.equal(gate.finishResume(id),false);
  assert.equal(gate.tryRetire(id),true);
  assert.equal(gate.retired,true);
});

test('quiescent resume cannot retire while loan receipts remain outstanding',()=>{
  const id=ticket(),gate=new PinnedContinuationGate(id);
  const a=gate.acquire(id,10,'shared'),b=gate.acquire(id,11,'shared');
  assert.ok(a&&b);
  assert.equal(gate.settle(id,'cancelled'),true);
  assert.equal(gate.brokerAcknowledge(id),true);
  assert.equal(gate.claimResume(id),true);
  assert.equal(gate.finishResume(id),true);
  assert.equal(gate.tryRetire(id),false);
  assert.equal(gate.release(id,10,a),true);
  assert.equal(gate.tryRetire(id),false);
  assert.equal(gate.release(id,11,b),true);
  assert.equal(gate.tryRetire(id),true);
  assert.equal(gate.acquire(id,12,'shared'),null);
  assert.equal(gate.release(id,10,a),false);
});

test('other actor generations cannot replay a prior operation receipt',()=>{
  const id=ticket(),gate=new PinnedContinuationGate(id);
  const old=gate.acquire(id,10,'exclusive');
  const wrong={...id,generation:id.generation+1};
  assert.ok(old);
  assert.equal(gate.release(wrong,10,old),false);
  assert.equal(gate.settle(wrong,'success'),false);
  assert.equal(gate.acquire(wrong,11,'shared'),null);
  assert.equal(gate.release(id,10,old),true);
  assert.equal(gate.liveReceipts,0);
});
