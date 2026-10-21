+import test from "node:test";
import assert from "node:assert/strict";
import {inspectWasmBytes} from "../scripts/inspect-core-memory.mjs";
import {admitCoreGuest} from "../src/guest-admission.mjs";

// Reference-only binary admission vectors: no guest compiler execution.
const header=[0,97,115,109,1,0,0,0];
const funcs=[3,2,1,0];
const memory=[5,4,1,1,1,2];
const exports=[7,17,2,4,109,97,105,110,0,0,6,109,101,109,111,114,121,2,0];
const code=[10,6,1,4,0,0x42,42,11];
const make=types=>Uint8Array.from([
 ...header,1,types.length,...types,...funcs,...memory,...exports,...code
]);

test("numeric function type remains a valid scalar core entry",()=>{
 const bytes=make([1,0x60,0,1,0x7e]);
 assert.equal(WebAssembly.validate(bytes),true);
 assert.equal(admitCoreGuest(bytes).profile,"core-wasm.i64-v1");
});

test("GC struct, array, recursive groups and explicit reference types fail before module compilation",()=>{
 const cases=[
  ["struct type", [1,0x5f,0]],
  ["array type", [1,0x5e,0x7f,0]],
  ["recursive type group", [1,0x4e,1,0x60,0,1,0x7e]],
  ["externref result", [1,0x60,0,1,0x6f]],
  ["funcref parameter", [1,0x60,1,0x70,1,0x7e]],
  ["typed reference result", [1,0x60,0,1,0x63]],
  ["SIMD result requires separate admission", [1,0x60,0,1,0x7b]],
 ];
 for(const [label,types] of cases){
  const bytes=make(types);
  assert.throws(()=>inspectWasmBytes(bytes),/GC|reference|vector|non-function/,
   label+" unexpectedly passed the byte-level strict scalar gate");
  assert.throws(()=>admitCoreGuest(bytes),/GC|reference|vector|non-function/,label);
 }
});

test("type signatures must be structurally bounded before Wasm compilation",()=>{
 for(const types of [
  [1,0x60,0,1], // truncated result
  [1,0x60,0,0,0], // surplus type bytes
  [1,0x60,0xff,0xff,0xff,0xff,0x0f] // huge argument count
 ]){
  assert.throws(()=>inspectWasmBytes(make(types)),/type budget|truncated|malformed|GC/);
 }
});

test("reference instructions in a code body are denied even with plain function types",()=>{
 const bytes=Uint8Array.from([
  ...header,1,5,1,0x60,0,1,0x7e,...funcs,...memory,...exports,
  10,9,1,7,0,0xd0,0x6f,0x1a,0x42,42,11
 ]);
 assert.throws(()=>inspectWasmBytes(bytes),/reference instruction forbidden|Wasm-GC opcode forbidden/);
 assert.throws(()=>admitCoreGuest(bytes),/reference instruction forbidden|Wasm-GC opcode forbidden/);
});
test("unknown GC opcode prefix cannot reach Wasm compilation",()=>{
 const bytes=Uint8Array.from([
  ...header,1,5,1,0x60,0,1,0x7e,...funcs,...memory,...exports,
  10,7,1,5,0,0xfb,0,0x42,42,11
 ]);
 assert.throws(()=>inspectWasmBytes(bytes),/reference instruction forbidden|Wasm-GC opcode forbidden/);
});

