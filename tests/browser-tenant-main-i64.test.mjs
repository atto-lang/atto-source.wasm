import test from 'node:test';
import assert from 'node:assert/strict';
import {admit_browser_guest} from '../src/browser-tenant-guest-admission.mjs';
const wasm=(s)=>Buffer.from(s.replaceAll(/\s+/g,''),'hex');
const scalar=wasm('0061736d01000000 0105016000017e 03020100 070801046d61696e0000 0a06010400422a0b');
const i32=wasm('0061736d01000000 0105016000017f 03020100 070801046d61696e0000 0a06010400412a0b');
const typeSection=Buffer.from([1,8,2,96,0,0,96,0,1,126]);
const importEntry=Buffer.from([4,...Buffer.from('atto'),13,...Buffer.from('print_newline'),0,0]);
const imported=Buffer.concat([scalar.subarray(0,8),typeSection,Buffer.from([2,1+importEntry.length,1,...importEntry]),
  Buffer.from([3,2,1,1]),Buffer.from([7,8,1,4,...Buffer.from('main'),0,1]),
  Buffer.from([10,6,1,4,0,0x42,42,11])]);
test('browser tenant accepts scalar main i64 42',()=>{
  const guest=admit_browser_guest(scalar);
  assert.equal(new WebAssembly.Instance(guest.module).exports.main(),42n);
});
test('browser tenant rejects valid zero-param main returning i32',()=>{
  assert.equal(WebAssembly.validate(i32),true);
  assert.throws(()=>admit_browser_guest(i32),/E_WASM_MAIN_SIGNATURE/);
});
test('allowlisted imported function cannot shift exported main type lookup',()=>{
  assert.equal(WebAssembly.validate(imported),true);
  const guest=admit_browser_guest(imported);
  assert.deepEqual(guest.imports,['atto.print_newline']);
  assert.equal(new WebAssembly.Instance(guest.module,{atto:{print_newline:()=>{}}}).exports.main(),42n);
});
