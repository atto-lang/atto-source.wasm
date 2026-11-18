import test from 'node:test';
import assert from 'node:assert/strict';
import {
 stateRegionProvenance,stateRegionReleaseRecord,stateRegionAuthorizesRelease
} from '../src/state-region-provenance.mjs';

const borrow=()=>({
 contractVersion:'1.0',regionId:2,regionGeneration:3,runtimeDomain:4,
 executionId:5,executionSlot:6,executionGeneration:7,loanId:8,
 place:'orders.items',kind:'read',action:'borrow'
});

test('null-prototype inert records snapshot into immutable provenance',()=>{
 const original=Object.assign(Object.create(null),borrow());
 const captured=stateRegionProvenance(original);
 assert.equal(Object.isFrozen(captured),true);
 original.executionGeneration=999;
 assert.equal(captured.executionGeneration,7);
 assert.equal(stateRegionAuthorizesRelease(captured,stateRegionReleaseRecord(captured)),true);
});

test('every physical loan component must agree on release',()=>{
 const original=borrow(),release=stateRegionReleaseRecord(original);
 for(const key of ['regionId','regionGeneration','runtimeDomain','executionId',
   'executionSlot','executionGeneration','loanId'])
  assert.equal(stateRegionAuthorizesRelease(original,{...release,[key]:release[key]+1}),false,key);
 assert.equal(stateRegionAuthorizesRelease(original,{...release,kind:'write'}),false);
 assert.equal(stateRegionAuthorizesRelease(original,{...release,place:'orders.other'}),false);
 assert.throws(()=>stateRegionReleaseRecord(release),/only a borrow/);
});

test('nonenumerable, symbol and inherited authority extras are refused',()=>{
 const hidden=borrow();
 Object.defineProperty(hidden,'memory',{value:new ArrayBuffer(8),enumerable:false});
 assert.throws(()=>stateRegionProvenance(hidden),/unknown state-region provenance field/);
 assert.throws(()=>stateRegionProvenance({...borrow(),[Symbol('memory')]:true}),
  /unknown state-region provenance field/);
 assert.throws(()=>stateRegionProvenance(
  Object.assign(Object.create({memory:true}),borrow())),/plain state-region/);
});

test('version and loan getters never execute during admission',()=>{
 let calls=0;
 for(const key of ['contractVersion','loanId']){
  const input=borrow();
  Object.defineProperty(input,key,{enumerable:true,get(){calls++;throw Error('hostile');}});
  assert.throws(()=>stateRegionProvenance(input),/accessor forbidden/);
 }
 assert.equal(calls,0);
});
