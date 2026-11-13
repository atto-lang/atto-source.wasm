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

test("proxy admission options are rejected without executing reflection traps",async()=>{
 const bytes=Uint8Array.from([1,2,3]);
 let traps=0;
 for(const trap of ["getPrototypeOf","ownKeys","getOwnPropertyDescriptor"]){
  const options=new Proxy({}, {[trap](){traps++;throw Error("attacker trap executed");}});
  await assert.rejects(runIsolatedCoreGuest(bytes,options),
   /guest runner options must not be proxies/);
 }
 const {proxy,revoke}=Proxy.revocable({},{});revoke();
 await assert.rejects(runIsolatedCoreGuest(bytes,proxy),
  /guest runner options must not be proxies/);
 assert.equal(traps,0);
});

test("entry and digest validation do not coerce adversarial object values",async()=>{
 const bytes=Uint8Array.from([1,2,3]);
 let coercions=0;
 for(const [field,output,error] of [
  ["entry","main",/invalid guest entry/],
  ["expectedSha256","0".repeat(64),/invalid pinned SHA-256/]
 ]){
  const value={
   [Symbol.toPrimitive](){coercions++;return output;},
   toString(){coercions++;return output;}
  };
  await assert.rejects(runIsolatedCoreGuest(bytes,{[field]:value}),error);
 }
 assert.equal(coercions,0);
});

test("runner entry export names obey the same 128-character budget as guest admission",async()=>{
 const bytes=Uint8Array.from([1,2,3]);
 await assert.rejects(runIsolatedCoreGuest(bytes,{entry:"x".repeat(129)}),
  /invalid guest entry/);
});
