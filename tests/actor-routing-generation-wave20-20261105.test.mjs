import test from 'node:test';
import assert from 'node:assert/strict';
import {ActorPipelineSelector,routeKeySlot} from '../src/actor-pipeline-selector.mjs';

const stages=()=>[
  {id:'source',actorType:'Producer',role:'readable',inbound:'',outbound:'Data'},
  {id:'sink',actorType:'Consumer',role:'writable',inbound:'Data',outbound:''}
];
const links=()=>[{source:'source',target:'sink',payload:'Data'}];

test('generation barriers are strictly increasing, explicit, and terminal after retirement',()=>{
  const p=new ActorPipelineSelector(stages(),links(),9);
  assert.equal(p.generation,9);
  assert.throws(()=>p.advanceGeneration(10,{}),/generation barrier required/);
  p.advanceGeneration(10,{quiescent:true}); assert.equal(p.generation,10);
  assert.throws(()=>p.advanceGeneration(10,{aborted:true}),/generation barrier required/);
  p.advanceGeneration(11,{aborted:true});assert.equal(p.generation,11);
  p.retire();p.retire();
  assert.throws(()=>p.forward('source'),/retired/);
  assert.throws(()=>p.advanceGeneration(12,{quiescent:true}),/retired/);
});

test('an attacker-controlled generation flag getter cannot run during admission',()=>{
  const p=new ActorPipelineSelector(stages(),links());
  let calls=0;
  const options={};
  Object.defineProperty(options,'quiescent',{get(){calls++;throw Error('getter ran');}});
  assert.throws(()=>p.advanceGeneration(2,options),/own booleans/);
  assert.equal(calls,0);
  assert.equal(p.generation,1);
  assert.throws(()=>p.advanceGeneration(2,{quiescent:'true'}),/own booleans/);
});

test('graph snapshots isolate mutable caller edges and reject fabricated roots',()=>{
  const s=stages(),e=links(),p=new ActorPipelineSelector(s,e);
  p.requireIngressRoot('source');
  const original=p.forward('source');
  assert.equal(Object.isFrozen(original),true);
  e[0].target='forged';s[1].id='forged';
  assert.equal(p.forward('source').target,'sink');
  assert.throws(()=>p.requireIngressRoot('sink'),/not an ingress root/);
  assert.throws(()=>p.forwardTo('source','forged'),/not connected/);
});

test('routing keys use bounded UTF-8 without treating caller data as topology metadata',()=>{
  for(const k of ['', '\0', 'é'.repeat(2048), 'task-α']){
    const a=routeKeySlot(k,4096),b=routeKeySlot(k,4096);
    assert.equal(a,b);assert.ok(a>=0&&a<4096);
  }
  for(const n of [0,-1,4097,1.5])assert.throws(()=>routeKeySlot('key',n),/invalid downstream edge count/);
  assert.throws(()=>routeKeySlot('é'.repeat(2049),2),/byte budget/);
});
