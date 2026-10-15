import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";

// Correct, import-free scalar Wasm with explicit bounded exported memory.
const wasm=Buffer.from([
  0,97,115,109,1,0,0,0,1,5,1,96,0,1,126,3,2,1,0,
  5,4,1,1,1,2,7,17,2,4,109,97,105,110,0,0,6,
  109,101,109,111,114,121,2,0,10,6,1,4,0,66,42,11
]);
test("unpinned worker result SHA is independently bound to submitted immutable bytes",async()=>{
  assert.equal(WebAssembly.validate(wasm),true);
  const actual=createHash("sha256").update(wasm).digest("hex");
  const result=await runIsolatedCoreGuest(wasm,{timeoutMs:3000});
  assert.equal(result.value,42n);
  assert.equal(result.admission.sha256,actual);
});
test("native real-source-to-AOT test is fail-closed when required compiler and runner paths are missing", async()=>{
  const {verifyRealSourceToAot}=await import("../scripts/verify-real-aot.mjs");
  await assert.rejects(verifyRealSourceToAot({compiler:null,builder:null,runner:null,compilerSha256:null,llvmSourceSha:null}),/paths required/);
});
