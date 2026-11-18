import test from 'node:test';
import assert from 'node:assert/strict';
import {Some,None,flattenOption} from '../src/wrapper-flatten-host.mjs';

test('flattening branded nested Options preserves original terminal identity',()=>{
  const leaf=Some({value:42});
  assert.strictEqual(flattenOption(Some(Some(leaf))),leaf);
  assert.strictEqual(flattenOption(Some(Some(None))),None);
  assert.strictEqual(flattenOption(None),None);
  assert.ok(Object.isFrozen(leaf));
});

test('unbranded lookalikes are never treated as structural Option authorities',()=>{
  const fake=Object.freeze({tag:'none'});
  assert.throws(()=>flattenOption(fake),/Option required/);
  const fakeSome={tag:'some',value:None};
  assert.throws(()=>flattenOption(fakeSome),/Option required/);
  const legitimate=Some(fakeSome);
  assert.strictEqual(flattenOption(legitimate),legitimate);
});

test('unbranded getters cannot run while checking nominal Option membership',()=>{
  let getters=0;
  const forged={};
  Object.defineProperty(forged,'tag',{get(){getters++;throw Error('untrusted getter');}});
  assert.throws(()=>flattenOption(forged),/Option required/);
  assert.equal(getters,0);
});
