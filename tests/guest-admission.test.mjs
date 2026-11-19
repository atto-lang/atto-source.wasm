import test from 'node:test';import assert from 'node:assert/strict';
import {admit_browser_guest,package_browser_guest} from '../src/browser-tenant-guest-admission.mjs';
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

test('admission rejects valid Wasm exports with bad main and actor arity',()=>{
  const wrong_main=Buffer.from(
    '0061736d0100000001060160017f017e03020100070801046d61696e00000a06010400422a0b','hex');
  const correct_actor=Buffer.from('0061736d0100000001190560017f017f60027f7e006000017e60017f0060037f7e7e00022602046174746f0b6163746f725f737061776e0000046174746f0a6163746f725f73656e6400010304030203040504010101010606017f0141000b073b05046d61696e00020a6163746f725f696e697400030d6163746f725f726563656976650004066d656d6f727902000a70616e69635f636f646503000a19030c00410010004205100142000b02000b070041072400000b00150b6174746f2e6163746f72730107436f756e746572','hex');
  const wrong_actor=Buffer.from(correct_actor.toString('hex')
    .replace('011905','011805').replace('60037f7e7e00','60027f7e00'),'hex');
  assert.equal(WebAssembly.validate(wrong_main),true);
  assert.equal(WebAssembly.validate(wrong_actor),true);
  assert.throws(()=>admit_browser_guest(wrong_main),/E_WASM_MAIN_SIGNATURE/);
  assert.throws(()=>admit_browser_guest(wrong_actor),/E_WASM_ACTOR_SIGNATURE/);
});
