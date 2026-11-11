import test from 'node:test';
import assert from 'node:assert/strict';
import {PinnedContinuationGate} from '../src/pinned-continuation-gate.mjs';

const ticket=()=>({actorId:3,generation:7,operationId:11});

test('shared loans block exclusive admission and physical retirement until released',()=>{
 const t=ticket(),gate=new PinnedContinuationGate(t);
 const one=gate.acquire(t,1,'shared'),two=gate.acquire(t,2,'shared');
 assert.ok(one&&two);
 assert.equal(gate.acquire(t,3,'exclusive'),null);
 assert.equal(gate.settle(t,'success'),true);
 assert.equal(gate.brokerAcknowledge(t),true);
 assert.equal(gate.claimResume(t),true);
 assert.equal(gate.finishResume(t),true);
 assert.equal(gate.tryRetire(t),false);
 assert.equal(gate.release(t,1,one),true);
 assert.equal(gate.tryRetire(t),false);
 assert.equal(gate.release(t,2,two),true);
 assert.equal(gate.tryRetire(t),true);
 assert.equal(gate.retired,true);
});

test('exclusive receipt is single-writer and unforgeable across borrower identities',()=>{
 const t=ticket(),gate=new PinnedContinuationGate(t);
 const receipt=gate.acquire(t,4,'exclusive');
 assert.ok(receipt);
 assert.equal(gate.acquire(t,5,'shared'),null);
 assert.equal(gate.release(t,5,receipt),false);
 assert.equal(gate.release(t,4,Object.freeze(Object.create(null))),false);
 assert.equal(gate.release(t,4,receipt),true);
 assert.equal(gate.release(t,4,receipt),false);
 assert.equal(gate.loanState.exclusive,false);
 assert.ok(gate.acquire(t,5,'shared'));
});

test('broker, resume and STOP ordering reject stale and replayed transitions',()=>{
 const t=ticket(),gate=new PinnedContinuationGate(t);
 const stale={...t,generation:8};
 assert.equal(gate.brokerAcknowledge(t),false);
 assert.equal(gate.claimResume(t),false);
 assert.equal(gate.settle(stale,'success'),false);
 assert.equal(gate.settle(t,'cancelled'),true);
 assert.equal(gate.settle(t,'failure'),false);
 assert.equal(gate.claimResume(t),false);
 assert.equal(gate.brokerAcknowledge(t),true);
 assert.equal(gate.brokerAcknowledge(t),false);
 assert.equal(gate.claimResume(t),true);
 assert.equal(gate.claimResume(t),false);
 assert.equal(gate.tryRetire(t),false);
 assert.equal(gate.finishResume(t),true);
 assert.equal(gate.finishResume(t),false);
 assert.equal(gate.tryRetire(t),true);
});

test('untrusted ticket accessors and forged identity cannot authorize physical loans',()=>{
 const t=ticket(),gate=new PinnedContinuationGate(t),bad=ticket();
 let reads=0;
 Object.defineProperty(bad,'generation',{enumerable:true,get(){reads++;throw Error('unsafe getter');}});
 assert.equal(gate.acquire(bad,1,'shared'),null);
 assert.equal(reads,0);
 assert.equal(gate.acquire({...t,operationId:12},1,'shared'),null);
 assert.equal(gate.settle(bad,'success'),false);
 assert.equal(gate.liveReceipts,0);
});
