import test from 'node:test';
import assert from 'node:assert/strict';
import {ActorPipelinePolicy} from '../src/actor-pipeline-policy.mjs';

const stages=()=>[
 {id:'producer',type:'Source',role:'readable',outbound:'Event'},
 {id:'consumer',type:'Sink',role:'writable',inbound:'Event'}
];
const edges=()=>[{source:'producer',target:'consumer',payload:'Event'}];

test('stage-array index getter is rejected without invocation',()=>{
 const s=stages(),e=edges();let calls=0;
 Object.defineProperty(s,'1',{configurable:true,enumerable:true,get(){calls++;throw Error('unsafe stage getter');}});
 assert.throws(()=>new ActorPipelinePolicy(s,e),/pipeline graph requires own data fields/);
 assert.equal(calls,0);
});

test('edge-array index getter is rejected without invocation',()=>{
 const s=stages(),e=edges();let calls=0;
 Object.defineProperty(e,'0',{configurable:true,enumerable:true,get(){calls++;throw Error('unsafe edge getter');}});
 assert.throws(()=>new ActorPipelinePolicy(s,e),/pipeline graph requires own data fields/);
 assert.equal(calls,0);
});

test('inherited index accessor cannot replace a missing own stage entry',()=>{
 const s=stages();delete s[1];let calls=0;
 const proto=Object.create(Array.prototype);
 Object.defineProperty(proto,'1',{get(){calls++;return stages()[1];}});
 Object.setPrototypeOf(s,proto);
 assert.throws(()=>new ActorPipelinePolicy(s,edges()),/pipeline graph requires own data fields/);
 assert.equal(calls,0);
});
