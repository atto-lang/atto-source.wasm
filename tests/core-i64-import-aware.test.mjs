import test from 'node:test';
import assert from 'node:assert/strict';
import {assertCoreI64Entry} from '../scripts/core-i64-abi.mjs';
const wasm=(s)=>Buffer.from(s.replaceAll(/\s+/g,''),'hex');
const scalar=wasm('0061736d01000000 0105016000017e 03020100 070801046d61696e0000 0a06010400422a0b');
const i32=wasm('0061736d01000000 0105016000017f 03020100 070801046d61696e0000 0a06010400412a0b');
const signatureImport=Buffer.from([1,8,2,96,0,0,96,0,1,126]);
const entry=Buffer.from([4,...Buffer.from('atto'),13,...Buffer.from('print_newline'),0,0]);
const imports=Buffer.from([2,1+entry.length,1,...entry]);
const imported=Buffer.concat([scalar.subarray(0,8),signatureImport,imports,
  Buffer.from([3,2,1,1]),Buffer.from([7,8,1,4,...Buffer.from('main'),0,1]),
  Buffer.from([10,6,1,4,0,0x42,42,11])]);
test('accepts exact scalar main () -> i64 from actual Wasm',()=>{
  assert.equal(WebAssembly.validate(scalar),true);
  assert.doesNotThrow(()=>assertCoreI64Entry(scalar,'main'));
  assert.equal(new WebAssembly.Instance(new WebAssembly.Module(scalar)).exports.main(),42n);
});
test('rejects main () -> i32 even though it has zero parameters',()=>{
  assert.equal(WebAssembly.validate(i32),true);
  assert.throws(()=>assertCoreI64Entry(i32,'main'),/exact \(\) -> i64/);
});
test('valid imported-function indices resolve to main () -> i64',()=>{
  assert.equal(WebAssembly.validate(imported),true);
  assert.doesNotThrow(()=>assertCoreI64Entry(imported,'main'));
  const m=new WebAssembly.Module(imported);
  assert.equal(new WebAssembly.Instance(m,{atto:{print_newline:()=>{}}}).exports.main(),42n);
});
test('forged function export index and missing entry reject',()=>{
  assert.throws(()=>assertCoreI64Entry(scalar,'not_main'),/exact \(\) -> i64/);
  assert.throws(()=>assertCoreI64Entry(new Uint8Array(), 'main'));
});
