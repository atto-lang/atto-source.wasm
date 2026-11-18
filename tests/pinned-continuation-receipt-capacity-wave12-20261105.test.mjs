import test from 'node:test';
import assert from 'node:assert/strict';
import {PinnedContinuationGate} from '../src/pinned-continuation-gate.mjs';
const ticket=()=>({actorId:7,generation:8,operationId:9});

test('64 live read receipts are bounded, and a released slot admits one more',()=>{
 const g=new PinnedContinuationGate(ticket());
 const receipts=[];
 for(let i=1;i<=64;i++)receipts.push(g.acquire(ticket(),i,'shared'));
 assert.ok(receipts.every(Boolean));assert.equal(g.liveReceipts,64);
 assert.equal(g.acquire(ticket(),65,'shared'),null);
 assert.equal(g.release(ticket(),1,receipts[0]),true);
 assert.equal(g.release(ticket(),1,receipts[0]),false);
 assert.ok(g.acquire(ticket(),65,'shared'));
 assert.equal(g.liveReceipts,64);
});
test('terminal transition cannot retire until broker, scheduler and leases finish',()=>{
 const g=new PinnedContinuationGate(ticket());
 const lease=g.acquire(ticket(),11,'exclusive');
 assert.equal(g.brokerAcknowledge(ticket()),false);
 assert.equal(g.claimResume(ticket()),false);
 assert.equal(g.finishResume(ticket()),false);
 assert.equal(g.settle(ticket(),'cancelled'),true);
 assert.equal(g.acquire(ticket(),12,'shared'),null);
 assert.equal(g.tryRetire(ticket()),false);
 assert.equal(g.brokerAcknowledge(ticket()),true);
 assert.equal(g.claimResume(ticket()),true);
 assert.equal(g.finishResume(ticket()),true);
 assert.equal(g.tryRetire(ticket()),false);
 assert.equal(g.release(ticket(),11,lease),true);
 assert.equal(g.tryRetire(ticket()),true);
 assert.equal(g.retired,true);
 assert.equal(g.tryRetire(ticket()),false);
});
test('forged ticket descriptors and foreign receipts preserve loan counts',()=>{
 const g=new PinnedContinuationGate(ticket());
 const receipt=g.acquire(ticket(),5,'shared');
 const hidden=ticket();
 Object.defineProperty(hidden,'generation',{value:8,enumerable:false});
 assert.equal(g.release(hidden,5,receipt),false);
 assert.equal(g.release(ticket(),6,receipt),false);
 assert.equal(g.release(ticket(),5,Object.freeze({})),false);
 assert.equal(g.liveReceipts,1);
 assert.equal(g.release(ticket(),5,receipt),true);
 assert.equal(g.liveReceipts,0);
});
test('shared and exclusive modes cannot overlap or admit unsafe borrower IDs',()=>{
 const g=new PinnedContinuationGate(ticket());
 const exclusive=g.acquire(ticket(),1,'exclusive');
 assert.ok(exclusive);
 assert.equal(g.acquire(ticket(),2,'shared'),null);
 assert.equal(g.acquire(ticket(),Number.MAX_SAFE_INTEGER+1,'exclusive'),null);
 assert.equal(g.release(ticket(),1,exclusive),true);
 const shared=g.acquire(ticket(),2,'shared');
 assert.ok(shared);
 assert.equal(g.acquire(ticket(),3,'exclusive'),null);
 assert.equal(g.release(ticket(),2,shared),true);
});
