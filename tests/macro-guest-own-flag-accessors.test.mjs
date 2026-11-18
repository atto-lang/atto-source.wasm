import test from "node:test";
import assert from "node:assert/strict";
import {requiresMacroWasm32Guest} from "../scripts/macro-wasm32-guest-gate.mjs";

test("own required guest flags are read only once, including null-prototype inputs",()=>{
 for(const key of [
   "ORESLANG_MACRO_WASM_PARITY_REQUIRED",
   "ORESLANG_REQUIRE_REAL_COMPILER"
 ]){
   const flags=Object.create(null);
   let reads=0;
   Object.defineProperty(flags,key,{enumerable:false,
     get(){reads++;return reads===1?"1":"0";}
   });
   assert.equal(requiresMacroWasm32Guest(flags),true,key);
   assert.equal(reads,1,key);
 }
});

test("throwing own required flag getter cannot silently skip native guests",()=>{
 const flags=Object.create(null);
 let reads=0;
 Object.defineProperty(flags,"ORESLANG_MACRO_WASM_PARITY_REQUIRED",{
   get(){reads++;throw Error("untrusted flag read");}
 });
 assert.throws(()=>requiresMacroWasm32Guest(flags),/untrusted flag read/);
 assert.equal(reads,1);
 assert.equal(requiresMacroWasm32Guest({
   ORESLANG_MACRO_WASM_PARITY_REQUIRED:"0",
   ORESLANG_REQUIRE_REAL_COMPILER:"1"
 }),true);
});
