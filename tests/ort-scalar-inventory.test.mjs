import test from "node:test";
import assert from "node:assert/strict";
import {REQUIRED,validateScalarInventory} from "../scripts/verify-ort-scalar-guest.mjs";

const base=()=>{
 const manifest={
  schema:"oreslang.option-result-trap.scalar/v3",status:"authored_not_executed",
  backends:["java","llvm","wasm","cranelift","net"],
  cases:REQUIRED.map(name=>({
    id:"ORT3-"+name.toUpperCase(),
    path:"fixtures/option-result-trap/v3/"+name+".ores",
    kind:"guest_i64",expected_return:"0",return_type:"int",
    requires_guest_execution:true
  }))
 };
 const lock={schema:"oreslang.option-result-trap.scalar-lock/v3",
  manifest_blob:"a".repeat(40),
  cases:manifest.cases.map(c=>({id:c.id,path:c.path,git_blob:"b".repeat(40)}))};
 return {manifest,lock};
};
test("nine pinned source-level scalar cases structurally admitted (not execution)",()=>{
 const {manifest,lock}=base();
 assert.doesNotThrow(()=>validateScalarInventory(manifest,lock));
});
test("rejects absent or duplicate native scalar source",()=>{
 const {manifest,lock}=base();
 manifest.cases.pop();
 assert.throws(()=>validateScalarInventory(manifest,lock));
 const another=base();
 another.lock.cases[0].id=another.lock.cases[1].id;
 assert.throws(()=>validateScalarInventory(another.manifest,another.lock));
});
test("rejects source-to-oracle substitution and unsupported profiles",()=>{
 for(const mutate of [
   ({manifest})=>manifest.cases[0].expected_return="1",
   ({manifest})=>manifest.cases[0].kind="compiler_check",
   ({manifest})=>manifest.cases[0].requires_guest_execution=false,
   ({manifest})=>manifest.backends[2]="forge",
   ({manifest})=>manifest.cases[0].path="../other.ores",
   ({lock})=>lock.manifest_blob="invalid",
   ({lock})=>lock.cases[1].git_blob="not-an-SHA"
 ]){
   const entry=base();mutate(entry);
   assert.throws(()=>validateScalarInventory(entry.manifest,entry.lock));
 }
});
