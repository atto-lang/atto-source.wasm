import test from 'node:test';
import assert from 'node:assert/strict';
import {stateRegionRequirement as admit,stateRegionRequirementAuthorizesRelease as releaseMatches} from '../src/state-region-requirement.mjs';

const borrow=(overrides={})=>({
  contractVersion:'1.0',regionBinding:'state.items',
  executionBinding:'current-logical-execution',generationFence:true,
  loanId:47,place:'state.items[0]',kind:'read',action:'borrow',...overrides
});

test('a release authorizes exactly the same loan, region, place and access kind',()=>{
  const b=borrow();
  assert.equal(releaseMatches(b,borrow({action:'release'})),true);
  for(const changes of [{loanId:48},{regionBinding:'state.other'},{place:'state.items[1]'},{kind:'write'}])
    assert.equal(releaseMatches(b,borrow({...changes,action:'release'})),false);
  assert.equal(releaseMatches(b,borrow()),false);
});

test('compiler requirement snapshots source values and rejects runtime authority fields',()=>{
  const source=borrow();
  const result=admit(source);
  source.loanId=99;
  assert.equal(result.loanId,47);
  assert.ok(Object.isFrozen(result));
  assert.throws(()=>admit(borrow({regionGeneration:1})),/compile-time requirement must not contain regionGeneration/);
  assert.throws(()=>admit(borrow({executionId:5})),/compile-time requirement must not contain executionId/);
  assert.throws(()=>admit(borrow({generationFence:false})),/must be generation fenced/);
});

test('hostile accessors, forged prototypes and symbol keys cannot admit authority',()=>{
  const data=borrow();
  let getterCalls=0;
  Object.defineProperty(data,'loanId',{enumerable:true,get(){getterCalls++;throw Error('hostile getter');}});
  assert.throws(()=>admit(data),/requirement accessor forbidden: loanId/);
  assert.equal(getterCalls,0);
  assert.throws(()=>admit(Object.create(borrow())),/plain state-region requirement record required/);
  assert.throws(()=>admit(borrow({[Symbol('source')]:true})),/unknown state-region requirement field/);
});
