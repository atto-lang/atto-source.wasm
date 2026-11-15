import test from 'node:test';import assert from 'node:assert/strict';
import {admit_browser_guest,package_browser_guest} from '../src/guest-admission.mjs';
const answer=Buffer.from('0061736d010000000105016000017e03020100070801046d61696e00000a06010400422a0b','hex');
test('admit concrete Wasm main returns 42 and publish digest manifest',async()=>{
  assert.equal(WebAssembly.validate(answer),true);
  const guest=admit_browser_guest(answer);
  assert.equal(guest.actors,false);assert.equal(new WebAssembly.Instance(guest.module).exports.main(),42n);
  const {wasm,manifest}=await package_browser_guest(answer);
  assert.equal(manifest.byte_length,answer.length);
  assert.match(manifest.wasm_sha256,/^[0-9a-f]{64}$/);
  assert.equal(manifest.protocol,'atto.browser.tenants.v1');
  assert.equal(manifest.route_wire,'atto.browser.route.v1');
  assert.equal(manifest.route_payload,'i64-signed-le8');
  assert.equal(manifest.send_receipt_protocol,'atto.browser.send-receipt.v1');
  assert.deepEqual(manifest.send_receipt_outcomes,['processed','rejected','unknown']);
  assert.deepEqual(Array.from(wasm),Array.from(answer));
});
test('reject invalid wasm and bad formats',()=>{
  assert.throws(()=>admit_browser_guest(new Uint8Array([1,2,3])),/E_WASM_INVALID/);
  assert.throws(()=>admit_browser_guest('bad'),/E_WASM_INPUT/);
  assert.throws(()=>admit_browser_guest(new Uint8Array(4*1024*1024+1)),/E_WASM_SIZE/);
});
