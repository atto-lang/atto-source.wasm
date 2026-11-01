import test from 'node:test';
import assert from 'node:assert/strict';
import {compileAdmittedCoreGuest} from '../src/guest-admission.mjs';
const malformed=new Uint8Array([0]); // admission must deny BEFORE guest parsing
test('unsupported WebSocket transport modes fail closed before guest decoding',()=>{
  for(const mode of ['server','client','liveview','native','auto',true,false,null,0,1,{}]) {
    assert.throws(()=>compileAdmittedCoreGuest(malformed,{websocketMode:mode}),
      /guest WebSocket client\/server transport unsupported/);
  }
});
test('unsupported LiveView updates fail before guest decoding',()=>{
  for(const value of [true,'false','true',0,1,null,{},[]]) {
    assert.throws(()=>compileAdmittedCoreGuest(malformed,{liveviewUpdates:value}),
      /LiveView session\/update actors unsupported/);
  }
});
test('default mode stays zero-capability scalar, not a silent WebSocket host fallback',()=>{
  assert.throws(()=>compileAdmittedCoreGuest(malformed),
    e=>!/WebSocket|LiveView/.test(e.message));
  assert.throws(()=>compileAdmittedCoreGuest(malformed,{websocketMode:'disabled',liveviewUpdates:false}),
    e=>!/WebSocket|LiveView/.test(e.message));
});
