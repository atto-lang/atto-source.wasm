import test from "node:test";
import assert from "node:assert/strict";
import {PinnedContinuationGate} from "../src/pinned-continuation-gate.mjs";

const ticket=()=>({actorId:11,generation:29,operationId:37});
test("pinned ticket constructor and lifecycle never read dynamic accessors",()=>{
 let invoked=0;
 for(const field of ["actorId","generation","operationId"]){
  const t=ticket();
  Object.defineProperty(t,field,{enumerable:true,get(){invoked++;return 11;}});
  assert.throws(()=>new PinnedContinuationGate(t),/invalid continuation ticket/);
 }
 assert.equal(invoked,0);
 const g=new PinnedContinuationGate(ticket());
 const forged=ticket();
 Object.defineProperty(forged,"actorId",{get(){invoked++;return 11;}});
 assert.equal(g.settle(forged,"success"),false);
 assert.equal(g.acquire(forged,7,"shared"),null);
 assert.equal(invoked,0);
 assert.equal(g.terminal,null);
});

test("physical pinned ticket identity stays stable across mutation and real release",()=>{
 const original=ticket(),g=new PinnedContinuationGate(original);
 original.generation++;
 assert.equal(g.settle(original,"success"),false);
 const good=ticket(),receipt=g.acquire(good,7,"shared");
 assert.ok(receipt);
 assert.equal(g.settle(good,"success"),true);
 assert.equal(g.brokerAcknowledge(good),true);
 assert.equal(g.claimResume(good),true);
 assert.equal(g.finishResume(good),true);
 assert.equal(g.tryRetire(good),false); // physical loan still pinned
 assert.equal(g.release(good,7,receipt),true);
 assert.equal(g.tryRetire(good),true);
 for(const invalid of [
  Object.create({actorId:11,generation:29,operationId:37}),
  {...ticket(),privilege:"extra"}
 ])assert.throws(()=>new PinnedContinuationGate(invalid),/invalid continuation ticket/);
});
