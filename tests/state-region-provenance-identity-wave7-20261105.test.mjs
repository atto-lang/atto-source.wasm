import test from 'node:test';
import assert from 'node:assert/strict';
import {stateRegionProvenance as admit,stateRegionAuthorizesRelease as matches,stateRegionReleaseRecord as release} from '../src/state-region-provenance.mjs';

const borrow=(patch={})=>({
  contractVersion:'1.0',regionId:2,regionGeneration:3,runtimeDomain:4,
  executionId:5,executionSlot:6,executionGeneration:7,loanId:8,
  place:'actor.state',kind:'read',action:'borrow',...patch
});

test('derived release carries every exact runtime identity and is immutable',()=>{
  const record=borrow();
  const derived=release(record);
  assert.equal(derived.action,'release');
  assert.equal(matches(record,derived),true);
  assert.ok(Object.isFrozen(derived));
  record.regionGeneration=99;
  assert.equal(derived.regionGeneration,3);
  assert.equal(matches(record,derived),false);
});

test('borrow and release must match each identity including slot and generation',()=>{
  const original=borrow();
  for(const patch of [{loanId:9},{executionSlot:9},{executionGeneration:9},{regionId:9},{runtimeDomain:9},{place:'actor.other'},{kind:'write'}]){
    assert.equal(matches(original,borrow({...patch,action:'release'})),false);
  }
  assert.throws(()=>release(borrow({action:'release'})),/only a borrow record/);
});

test('untrusted getters and unknown symbolic authority never execute or materialize',()=>{
  const source=borrow();
  let calls=0;
  Object.defineProperty(source,'executionId',{enumerable:true,get(){calls++;throw Error('get execution');}});
  assert.throws(()=>admit(source),/state-region provenance accessor forbidden: executionId/);
  assert.equal(calls,0);
  assert.throws(()=>admit(borrow({[Symbol('privilege')]:true})),/unknown state-region provenance field/);
  assert.throws(()=>admit(borrow({loanId:Number.MAX_SAFE_INTEGER+1})),/positive safe integer/);
  assert.throws(()=>admit(Object.create(borrow())),/plain state-region provenance record required/);
});
