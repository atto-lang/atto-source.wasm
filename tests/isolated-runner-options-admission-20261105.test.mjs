import test from "node:test";
import assert from "node:assert/strict";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";

test("isolated runner cannot invoke accessor-backed worker options",async()=>{
 let getters=0;
 for(const field of ["expectedSha256","entry","maxMemoryPages","maxModuleBytes","timeoutMs","namespaceBindings"]){
  const opts={};
  Object.defineProperty(opts,field,{enumerable:true,get(){getters++;return 2000;}});
  await assert.rejects(runIsolatedCoreGuest(new Uint8Array(0),opts),
   /guest runner options require own data fields/);
 }
 assert.equal(getters,0);
});
test("trusted own options retain fail-closed byte and execution gates",async()=>{
 const bytes=Uint8Array.from([1,2,3]);
 await assert.rejects(runIsolatedCoreGuest(bytes,{entry:"init"}),
  /WASM init lifecycle cannot be invoked as a guest entry/);
 await assert.rejects(runIsolatedCoreGuest(bytes,{namespaceBindings:{}}),
  /WASM namespace linking requires verified package index/);
 await assert.rejects(runIsolatedCoreGuest(bytes,{timeoutMs:0}),
  /timeoutMs must be between/);
 for(const invalid of [null,[],Object.create({timeoutMs:10}),{untrusted:true}]){
  await assert.rejects(runIsolatedCoreGuest(bytes,invalid));
 }
 const symbols={};symbols[Symbol("authority")]=true;
 await assert.rejects(runIsolatedCoreGuest(bytes,symbols),/unknown guest runner option/);
});
