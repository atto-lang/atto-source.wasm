import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
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

test("AOT gate requires independently pinned builder and runner hashes",async()=>{
  const {verifyRealSourceToAot}=await import("../scripts/verify-real-aot.mjs");
  await assert.rejects(verifyRealSourceToAot({
    compiler:"/bin/false",compilerSha256:"0".repeat(64),llvmSourceSha:"0".repeat(40),
    builder:"/bin/false",runner:"/bin/false"
  }),/pinned AOT builder and development runner SHA-256 values are required/);
});
test("AOT gate rejects altered builder or runner bytes before execution",async()=>{
  const {verifyRealSourceToAot}=await import("../scripts/verify-real-aot.mjs");
  const dir=await mkdtemp(join(tmpdir(),"oreslang-aot-tool-pin-"));
  try{
    const tool=join(dir,"fixture-tool");
    const bytes=Buffer.from("#!/bin/sh\\nexit 93\\n");
    await writeFile(tool,bytes,{flag:"wx",mode:0o700});
    const good=createHash("sha256").update(bytes).digest("hex");
    const opts={
      compiler:tool,compilerSha256:good,llvmSourceSha:"a".repeat(40),
      builder:tool,builderSha256:good,runner:tool,runnerSha256:good
    };
    await assert.rejects(verifyRealSourceToAot({...opts,builderSha256:"0".repeat(64)}),
      /native AOT builder digest mismatch/);
    await assert.rejects(verifyRealSourceToAot({...opts,runnerSha256:"0".repeat(64)}),
      /native AOT runner digest mismatch/);
  }finally{await rm(dir,{recursive:true,force:true})}
});
