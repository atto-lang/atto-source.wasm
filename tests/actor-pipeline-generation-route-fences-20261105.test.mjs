import test from 'node:test';
import assert from 'node:assert/strict';
import {ActorPipelineSelector,routeKeySlot} from '../src/actor-pipeline-selector.mjs';

const graph=()=>({
 stages:[
  {id:'entry',actorType:'Ingress',role:'readable',inbound:'',outbound:'data'},
  {id:'left',actorType:'Sink',role:'writable',inbound:'data',outbound:''},
  {id:'right',actorType:'Sink',role:'writable',inbound:'data',outbound:''}],
 links:[{source:'entry',target:'left',payload:'data'},
        {source:'entry',target:'right',payload:'data'}]
});
test('round-robin resets only after an explicit generation fence',()=>{
 const g=graph(),r=new ActorPipelineSelector(g.stages,g.links,3);
 assert.equal(r.forwardRoundRobin('entry').target,'left');
 assert.equal(r.forwardRoundRobin('entry').target,'right');
 assert.throws(()=>r.forward('entry'),/ambiguous forward/);
 assert.throws(()=>r.advanceGeneration(4,{}),/generation barrier required/);
 r.advanceGeneration(4,{quiescent:true});
 assert.equal(r.forwardRoundRobin('entry').target,'left');
});
test('source mutation, forged flag getters and retirement cannot redirect delivery',()=>{
 const g=graph(),r=new ActorPipelineSelector(g.stages,g.links,9);
 g.stages[1].id='forged';g.links[0].target='forged';
 assert.equal(r.forwardTo('entry','left').target,'left');
 let hits=0;const opts={};
 Object.defineProperty(opts,'aborted',{get(){hits++;return true;}});
 assert.throws(()=>r.advanceGeneration(10,opts),/own booleans/);
 assert.equal(hits,0);
 r.advanceGeneration(10,{aborted:true});
 r.retire();
 assert.throws(()=>r.forwardAll('entry'),/retired/);
});
test('UTF-8 budgets and topology field accessors fail closed',()=>{
 assert.equal(routeKeySlot('😀'.repeat(1024),3),routeKeySlot('😀'.repeat(1024),3));
 assert.throws(()=>routeKeySlot('😀'.repeat(1025),3),/byte budget/);
 assert.throws(()=>routeKeySlot('\ud800',3),/malformed routing UTF-16/);
 const g=graph();let calls=0;
 Object.defineProperty(g.stages[0],'id',{get(){calls++;return 'entry';}});
 assert.throws(()=>new ActorPipelineSelector(g.stages,g.links),/own data fields/);
 assert.equal(calls,0);
});