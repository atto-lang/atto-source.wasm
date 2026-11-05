import test from 'node:test';
import assert from 'node:assert/strict';
import {Some,None,flattenOption} from '../src/wrapper-flatten-host.mjs';

test('nested branded Option flattens without copying payload',()=>{
  const payload=Object.freeze({id:19});
  const inner=Some(payload);
  const nested=Some(Some(inner));
  assert.equal(Object.isFrozen(nested),true);
  assert.strictEqual(flattenOption(nested),inner);
  assert.strictEqual(flattenOption(nested).value,payload);
});
test('None preserves singleton identity under nested flatten',()=>{
  assert.strictEqual(flattenOption(None),None);
  assert.strictEqual(flattenOption(Some(Some(None))),None);
  assert.equal(Object.isFrozen(None),true);
});
test('lookalike and inherited wrappers cannot forge nominal authority',()=>{
  const inner=Some(3);
  const forged=Object.freeze({tag:'some',value:inner});
  assert.throws(()=>flattenOption(forged),/Option required/);
  assert.throws(()=>flattenOption(Object.create(forged)),/Option required/);
  assert.throws(()=>flattenOption(3),/Option required/);
});
