import test from 'node:test';
import assert from 'node:assert/strict';
import {ActorPipelinePolicy} from '../src/actor-pipeline-policy.mjs';

const graph=()=>({
 stages:[{id:'source',type:'Source',role:'readable',outbound:'Event'},
         {id:'sink',type:'Sink',role:'writable',inbound:'Event'}],
 edges:[{source:'source',target:'sink',payload:'Event'}]
});

test('stage and edge accessors fail before caller-supplied getters run',()=>{
 for(const field of ['id','type','role','outbound']){
  const {stages,edges}=graph();
  let called=0;
  Object.defineProperty(stages[0],field,{get(){called++;throw Error('getter executed');}});
  assert.throws(()=>new ActorPipelinePolicy(stages,edges),/pipeline graph requires own data fields/);
  assert.equal(called,0,field);
 }
 for(const field of ['source','target','payload']){
  const {stages,edges}=graph();
  let called=0;
  Object.defineProperty(edges[0],field,{get(){called++;throw Error('getter executed');}});
  assert.throws(()=>new ActorPipelinePolicy(stages,edges),/pipeline graph requires own data fields/);
  assert.equal(called,0,field);
 }
});

test('array element getters and custom iterators do not influence graph admission',()=>{
 const {stages,edges}=graph();
 let called=0;
 Object.defineProperty(stages,Symbol.iterator,{get(){called++;throw Error('iterator executed');}});
 Object.defineProperty(edges,Symbol.iterator,{get(){called++;throw Error('iterator executed');}});
 const policy=new ActorPipelinePolicy(stages,edges);
 assert.equal(policy.forward('source').target,'sink');
 assert.equal(called,0);
 Object.defineProperty(stages,'0',{get(){called++;throw Error('index getter executed');}});
 assert.throws(()=>new ActorPipelinePolicy(stages,edges),/pipeline graph requires own data fields/);
 assert.equal(called,0);
});

test('routing captures immutable graph identity before caller mutates input records',()=>{
 const {stages,edges}=graph();
 const p=new ActorPipelinePolicy(stages,edges);
 stages[0].id='spoofed';stages[1].id='new-sink';edges[0].target='spoofed';
 const route=p.forward('source');
 assert.equal(route.source,'source');
 assert.equal(route.target,'sink');
 assert.equal(Object.isFrozen(route),true);
 assert.throws(()=>{route.target='rewritten';},TypeError);
 assert.equal(p.forward('source').target,'sink');
});