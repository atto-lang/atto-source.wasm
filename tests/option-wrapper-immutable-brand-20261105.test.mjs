import test from 'node:test';
import assert from 'node:assert/strict';
import {Some,None,flattenOption} from '../src/wrapper-flatten-host.mjs';

test('nominal Option identity is preserved through nested flattening',()=>{
  const leaf=Some({answer:42});
  const wrapped=Some(Some(leaf));
  assert.strictEqual(flattenOption(wrapped),leaf);
  assert.strictEqual(flattenOption(Some(None)),None);
  assert.ok(Object.isFrozen(leaf));assert.ok(Object.isFrozen(None));
});
test('an unbranded terminal payload remains an opaque value of the outer Some',()=>{
  const payload=Object.freeze({tag:'some',value:None});
  const outer=Some(payload);
  assert.strictEqual(flattenOption(outer),outer);
  assert.strictEqual(outer.value,payload);
});
test('structural forgeries, including inherited tags, have no nominal authority',()=>{
  assert.throws(()=>flattenOption(Object.freeze({tag:'none'})),/Option required/);
  const forged=Object.create(None);
  assert.throws(()=>flattenOption(forged),/Option required/);
});
test('caller getters never run when checking an unbranded wrapper',()=>{
  let called=0;const fake={};
  Object.defineProperty(fake,'tag',{get(){called++;throw Error('untrusted getter');}});
  assert.throws(()=>flattenOption(fake),/Option required/);
  assert.equal(called,0);
});
