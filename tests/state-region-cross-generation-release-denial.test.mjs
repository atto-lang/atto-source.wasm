import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stateRegionProvenance,stateRegionReleaseRecord,stateRegionAuthorizesRelease
} from '../src/state-region-provenance.mjs';

const borrow=()=>({
  contractVersion:'1.0',regionId:7,regionGeneration:3,runtimeDomain:2,
  executionId:11,executionSlot:4,executionGeneration:5,loanId:23,
  place:'inventory.stock',kind:'write',action:'borrow'
});

test('release derivation freezes all runtime identities and only switches action',()=>{
  const original=borrow();
  const release=stateRegionReleaseRecord(original);
  assert.equal(Object.isFrozen(release),true);
  assert.equal(release.action,'release');
  assert.equal(stateRegionAuthorizesRelease(original,release),true);
  original.loanId=99;
  assert.equal(release.loanId,23);
  assert.equal(stateRegionAuthorizesRelease(borrow(),release),true);
});

test('no other region, execution, slot, generation, loan or access kind can release the borrow',()=>{
  const original=borrow();
  const release=stateRegionReleaseRecord(original);
  for(const field of [
    'regionId','regionGeneration','runtimeDomain','executionId',
    'executionSlot','executionGeneration','loanId'
  ])assert.equal(stateRegionAuthorizesRelease(original,
    {...release,[field]:release[field]+1}),false,field);
  for(const patch of [{kind:'read'},{place:'inventory.other'}])
    assert.equal(stateRegionAuthorizesRelease(original,{...release,...patch}),false);
  assert.equal(stateRegionAuthorizesRelease(release,release),false);
  assert.equal(stateRegionAuthorizesRelease(original,original),false);
});

test('invalid numeric identities cannot participate in any release proof',()=>{
  const valid=borrow();
  const release=stateRegionReleaseRecord(valid);
  for(const field of ['regionId','regionGeneration','runtimeDomain','executionId',
                       'executionSlot','executionGeneration','loanId']){
    for(const invalid of [0,-1,1.5,NaN,Number.MAX_SAFE_INTEGER+1]){
      assert.throws(()=>stateRegionProvenance({...valid,[field]:invalid}),
        /positive safe integer/,field);
      assert.throws(()=>stateRegionAuthorizesRelease(
        valid,{...release,[field]:invalid}),/positive safe integer/,field);
    }
  }
});

test('release receipt getters cannot run and unknown hidden metadata cannot grant memory',()=>{
  let calls=0;
  const forged=stateRegionReleaseRecord(borrow());
  const withGetter={...forged};
  Object.defineProperty(withGetter,'executionGeneration',{enumerable:true,get(){
    calls++;throw Error('untrusted execution getter');
  }});
  assert.throws(()=>stateRegionAuthorizesRelease(borrow(),withGetter),
    /accessor forbidden/);
  assert.equal(calls,0);
  assert.throws(()=>stateRegionAuthorizesRelease(
    borrow(),{...forged,[Symbol('hostPointer')]:new ArrayBuffer(8)}),
    /unknown state-region provenance field/);
});
