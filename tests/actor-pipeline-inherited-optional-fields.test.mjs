import test from 'node:test';
import assert from 'node:assert/strict';
import {ActorPipelinePolicy} from '../src/actor-pipeline-policy.mjs';

const edge=()=>({source:'producer',target:'consumer',payload:'Event'});
const source=()=>({id:'producer',type:'Source',role:'readable',outbound:'Event'});
const sink=()=>({id:'consumer',type:'Sink',role:'writable',inbound:'Event'});

test('optional ports ignore inherited hostile getters without invoking them',()=>{
 let getterCalls=0;
 const s=source(),t=sink();
 Object.setPrototypeOf(s,Object.defineProperty({},'inbound',{get(){getterCalls++;throw Error('ambient inbound');}}));
 Object.setPrototypeOf(t,Object.defineProperty({},'outbound',{get(){getterCalls++;throw Error('ambient outbound');}}));
 const plan=new ActorPipelinePolicy([s,t],[edge()]);
 assert.equal(plan.forward('producer').target,'consumer');
 assert.equal(getterCalls,0);
});

test('required stage identity must be own data even when inherited getter supplies it',()=>{
 let calls=0;
 const s=source();delete s.id;
 Object.setPrototypeOf(s,Object.defineProperty({},'id',{get(){calls++;return 'producer';}}));
 assert.throws(()=>new ActorPipelinePolicy([s,sink()],[edge()]),/pipeline graph requires own data fields/);
 assert.equal(calls,0);
});

test('required edge target cannot be provided through the prototype chain',()=>{
 let calls=0;
 const e=edge();delete e.target;
 Object.setPrototypeOf(e,Object.defineProperty({},'target',{get(){calls++;return 'consumer';}}));
 assert.throws(()=>new ActorPipelinePolicy([source(),sink()],[e]),/pipeline graph requires own data fields/);
 assert.equal(calls,0);
});
