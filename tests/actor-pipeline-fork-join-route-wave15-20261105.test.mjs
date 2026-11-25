// Source-local actor routing host reference only; no guest scheduler execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ActorPipelineSelector,routeKeySlot} from '../src/actor-pipeline-selector.mjs';
const stages=()=>[
 {id:'entry',actorType:'Producer',role:'readable',inbound:'',outbound:'Event'},
 {id:'left',actorType:'Transform',role:'transform',inbound:'Event',outbound:'Event'},
 {id:'right',actorType:'Transform',role:'transform',inbound:'Event',outbound:'Event'},
 {id:'join',actorType:'Sink',role:'writable',inbound:'Event',outbound:''}
];
const links=()=>[
 {source:'entry',target:'left',payload:'Event'},
 {source:'entry',target:'right',payload:'Event'},
 {source:'left',target:'join',payload:'Event'},
 {source:'right',target:'join',payload:'Event'}
];

test('fork-join DAG preserves independent fanout and generation-reset rotation',()=>{
 const nodes=stages(),edges=links(),p=new ActorPipelineSelector(nodes,edges,19);
 p.requireIngressRoot('entry');
 assert.deepEqual(p.forwardAll('entry').map(e=>e.target),['left','right']);
 assert.deepEqual(Array.from({length:5},()=>p.forwardRoundRobin('entry').target),
                  ['left','right','left','right','left']);
 assert.equal(p.forwardTo('right','join').source,'right');
 assert.throws(()=>p.requireIngressRoot('left'),/not an ingress root/);
 assert.throws(()=>p.forward('entry'),/ambiguous forward/);
 p.advanceGeneration(20,{aborted:true});
 assert.equal(p.forwardRoundRobin('entry').target,'left');
 nodes[1].id='compromised';edges[0].target='join';
 assert.equal(p.forwardTo('entry','left').target,'left');
 assert.throws(()=>p.forwardTo('entry','compromised'),/not connected/);
 p.retire();assert.throws(()=>p.forwardRoundRobin('entry'),/retired/);
});

test('fork-join rejects cycles, duplicate edges and malformed port contracts',()=>{
 const e=links();
 assert.throws(()=>new ActorPipelineSelector(stages(),[...e,e[0]]),/duplicate actor edge/);
 assert.throws(()=>new ActorPipelineSelector(stages(),e.map((v,i)=>i===2?{...v,payload:'Other'}:v)),/payload mismatch/);
 assert.throws(()=>new ActorPipelineSelector(stages().map((v,i)=>i===3?{...v,role:'readable'}:v),e),/invalid actor port role/);
 const mut=links();
 mut[2]={source:'join',target:'left',payload:'Event'};
 assert.throws(()=>new ActorPipelineSelector(stages(),mut),/actor edge payload mismatch/);
});

test('untrusted edge selectors never execute entry getter or custom iterators',()=>{
 let calls=0;
 const e=links(),s=stages();
 Object.defineProperty(e,'0',{configurable:true,get(){calls++;throw Error('edge getter');}});
 assert.throws(()=>new ActorPipelineSelector(s,e),/own data fields/);
 const e2=links();Object.defineProperty(e2,Symbol.iterator,{value(){calls++;throw Error('iterator');}});
 const p=new ActorPipelineSelector(s,e2,1);
 assert.equal(calls,0);
 assert.equal(p.forwardByKey('entry','\0').target,p.forwardByKey('entry','\0').target);
 for(const count of [0,-1,4097,1.5])assert.throws(()=>routeKeySlot('key',count),/invalid downstream edge count/);
 assert.throws(()=>routeKeySlot('é'.repeat(2049),2),/byte budget/);
 assert.ok(routeKeySlot('é'.repeat(2048),2)>=0);
});
