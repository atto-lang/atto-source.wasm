import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveSpawnCharge as resolve} from '../src/actor-spawn-charge-plan.mjs';
const p = {serial:false,carrierCap:4,defaultCarriers:2,liveStackSlots:8n,heapLimit:1000n,stackLimit:100n,mailboxMessagesLimit:50n,mailboxByteCharge:4096n};
const d = {affinity:'sticky',heapBytes:500n,stackBytes:50n,mailboxMessages:10n};
test('fixed-profile defaults and narrowing preserve independent charges', () => {
  assert.deepEqual(resolve(p,d,{}),{carrierCap:2,affinity:'sticky',stackBytes:50n,heap:500n,stacks:400n,mailboxBytes:4096n,messages:10n});
  assert.deepEqual(resolve(p,d,{carriers:1,affinity:'pinned',heapBytes:300n,stackBytes:20n,mailboxMessages:3n}),{carrierCap:1,affinity:'pinned',stackBytes:20n,heap:300n,stacks:160n,mailboxBytes:4096n,messages:3n});
  assert.ok(Object.isFrozen(resolve(p,d,{})));
});
test('invalid caps, affinity, and serial metadata deny', () => {
  for (const carriers of [0,-1,5,1.5,1n,Infinity]) assert.throws(()=>resolve(p,d,{carriers}),{message:'E_SPAWN_POLICY'});
  for (const affinity of ['pinned','dedicated','unknown']) assert.throws(()=>resolve(p,d,{affinity}),{message:'E_SPAWN_POLICY'});
  const serial={...p,serial:true,carrierCap:1,defaultCarriers:1};
  assert.equal(resolve(serial,d,{}).carrierCap,1);
  assert.throws(()=>resolve(serial,d,{carriers:2}),{message:'E_SPAWN_POLICY'});
  assert.throws(()=>resolve({...serial,carrierCap:2},d,{}),{message:'E_SPAWN_POLICY'});
});
test('signed i64 resource bounds, checked multiplication and defaults', () => {
  for (const heapBytes of [0n,-1n,1001n,1, '1', 1n<<63n]) assert.throws(()=>resolve(p,d,{heapBytes}),{message:'E_SPAWN_QUOTA'});
  assert.throws(()=>resolve(p,d,{stackBytes:101n}),{message:'E_SPAWN_QUOTA'});
  assert.throws(()=>resolve(p,d,{mailboxMessages:51n}),{message:'E_SPAWN_QUOTA'});
  assert.throws(()=>resolve(p,{...d,heapBytes:0n},{heapBytes:10n}),{message:'E_SPAWN_QUOTA'});
  const max=(1n<<63n)-1n, huge={...p,liveStackSlots:max};
  assert.throws(()=>resolve(huge,d,{}),{message:'E_SPAWN_QUOTA'});
  assert.equal(resolve(huge,{...d,stackBytes:1n},{}).stacks,max);
  assert.throws(()=>resolve({...p,mailboxByteCharge:0n},d,{}),{message:'E_SPAWN_POLICY'});
});
