import test from 'node:test';
import assert from 'node:assert/strict';
import {ActorPipelinePolicy} from '../src/actor-pipeline-policy.mjs';

const graph=()=>({
 stages:[{id:'source',type:'Producer',role:'readable',outbound:'Event'},...['a','b','c'].map(id=>({id,type:'Sink',role:'writable',inbound:'Event'}))],
 edges:['a','b','c'].map(target=>({source:'source',target,payload:'Event'}))
});
const make=()=>{const {stages,edges}=graph();return new ActorPipelinePolicy(stages,edges);};

test('separate policy generations own independent round-robin cursors',()=>{
 const first=make(),second=make();
 assert.equal(first.forwardRoundRobin('source').target,'a');
 assert.equal(first.forwardRoundRobin('source').target,'b');
 assert.equal(second.forwardRoundRobin('source').target,'a');
 assert.equal(first.forwardRoundRobin('source').target,'c');
 assert.equal(second.forwardRoundRobin('source').target,'b');
 first.close();
 assert.equal(second.forwardRoundRobin('source').target,'c');
 assert.equal(make().forwardRoundRobin('source').target,'a');
});

test('forwardByKey and forwardTo are read-only with respect to the RR cursor',()=>{
 const plan=make();
 for(let i=0;i<50;i++){
  plan.forwardByKey('source','key-'+i);
  assert.equal(plan.forwardTo('source','b').target,'b');
  assert.equal(plan.forwardAll('source').length,3);
 }
 assert.equal(plan.forwardRoundRobin('source').target,'a');
 assert.equal(plan.forwardRoundRobin('source').target,'b');
 plan.forwardByKey('source','one last key');
 assert.equal(plan.forwardRoundRobin('source').target,'c');
});

test('retired generation cannot advance or reveal routing state',()=>{
 const p=make();p.forwardRoundRobin('source');p.close();
 for(const fn of [()=>p.forwardAll('source'),()=>p.forwardRoundRobin('source'),()=>p.forwardByKey('source','anything'),()=>p.forwardTo('source','a')])
  assert.throws(fn,/retired pipeline generation/);
});
