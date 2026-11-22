import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshotCompilerTrustRecord as snap} from '../src/compiler-trust-record.mjs';
const fields=['source_head','source_tree','compiler_sha256'];
const good=()=>({source_head:'a'.repeat(40),source_tree:'b'.repeat(40),compiler_sha256:'c'.repeat(64)});
test('captures independent immutable own-data trust identity',()=>{
  const input=good(), copied=snap(input,fields,'pins');
  input.source_head='0'.repeat(40);
  assert.equal(copied.source_head,'a'.repeat(40));
  assert.ok(Object.isFrozen(copied));
  assert.equal(Object.getPrototypeOf(copied),null);
});
test('rejects a getter without invoking untrusted receipt code',()=>{
  let called=0;
  const input=good();
  Object.defineProperty(input,'source_head',{enumerable:true,get(){called++;return 'a'.repeat(40)}});
  assert.throws(()=>snap(input,fields,'pins'),/E_TRUST: pins/);
  assert.equal(called,0);
});
test('rejects own symbol fields, extra keys and inherited identity',()=>{
  const input=good();input[Symbol('hidden')]='cap';
  assert.throws(()=>snap(input,fields,'pins'),/E_TRUST: pins/);
  delete input[Object.getOwnPropertySymbols(input)[0]];
  input.extra='cap';assert.throws(()=>snap(input,fields,'pins'),/E_TRUST: pins/);
  const inherited=Object.create(good());
  assert.throws(()=>snap(inherited,fields,'pins'),/E_TRUST: pins/);
});
test('accepts null-prototype trusted data records',()=>{
  const record=Object.assign(Object.create(null),good());
  assert.equal(snap(record,fields,'pins').compiler_sha256,'c'.repeat(64));
});
test('rejects incomplete/non-enumerable authority slots',()=>{
  const missing=good();delete missing.source_tree;
  assert.throws(()=>snap(missing,fields,'pins'),/E_TRUST: pins/);
  const hidden=good();Object.defineProperty(hidden,'source_tree',{enumerable:false});
  assert.throws(()=>snap(hidden,fields,'pins'),/E_TRUST: pins/);
});
