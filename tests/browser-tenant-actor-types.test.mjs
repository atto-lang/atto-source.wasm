import test from 'node:test';
import assert from 'node:assert/strict';
import {admit_browser_guest} from '../src/browser-tenant-guest-admission.mjs';
const good=Buffer.from('0061736d0100000001190560017f017f60027f7e006000017e60017f0060037f7e7e00022602046174746f0b6163746f725f737061776e0000046174746f0a6163746f725f73656e6400010304030203040504010101010606017f0141000b073b05046d61696e00020a6163746f725f696e697400030d6163746f725f726563656976650004066d656d6f727902000a70616e69635f636f646503000a19030c00410010004205100142000b02000b070041072400000b00150b6174746f2e6163746f72730107436f756e746572','hex');
// Edit a type signature only: both variants remain valid WebAssembly with
// identical function arity, so function.length alone is insufficient.
function change(pattern,index,type){
  const b=Buffer.from(good);const pos=b.indexOf(Buffer.from(pattern,'hex'));
  assert.ok(pos>=0);b[pos+index]=type;
  assert.equal(WebAssembly.validate(b),true);
  return b;
}
test('typed actor guest fixture is valid before policy enforcement',()=>{
  assert.equal(WebAssembly.validate(good),true);
  const guest=admit_browser_guest(good);
  assert.equal(guest.actors,true);
  assert.deepEqual(guest.actor_names,['Counter']);
});
test('actor_init(i64) with unchanged arity is rejected',()=>{
  const v=change('60017f006003',2,0x7e);
  assert.throws(()=>admit_browser_guest(v),/E_WASM_ACTOR_SIGNATURE/);
});
test('actor_receive(i32,i32,i64) with unchanged arity is rejected',()=>{
  const v=change('60037f7e7e00',3,0x7f);
  assert.throws(()=>admit_browser_guest(v),/E_WASM_ACTOR_SIGNATURE/);
});
