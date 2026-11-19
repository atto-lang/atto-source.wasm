import test from "node:test";
import assert from "node:assert/strict";
import {compileAdmittedCoreGuest} from "../src/guest-admission.mjs";

test("scalar guest rejects oversized export names before touching Wasm bytes",()=>{
 const unreadable=new Uint8Array(8);
 for(const entry of ["A".repeat(129),"main"+"x".repeat(128),123,null]) {
  assert.throws(()=>compileAdmittedCoreGuest(unreadable,{entry}),/invalid guest entry/);
 }
 // The exact 128-character edge passes entry-name admission and reaches the
 // deliberately invalid Wasm fixture, without claiming guest compilation.
 assert.throws(()=>compileAdmittedCoreGuest(unreadable,{entry:"A".repeat(128)}),
  /invalid core module header/);
});
