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

test("native AOT verifier SHA is derived from a bounded no-follow regular-file snapshot",async()=>{
  const {open,symlink} = await import("node:fs/promises");
  const {sha256BoundedNativeArtifact} = await import("../scripts/verify-real-aot.mjs");
  const dir=await mkdtemp(join(tmpdir(),"oreslang-native-artifact-bound-"));
  try{
    const good=join(dir,"valid.cwasm");
    const content=Buffer.from("verified small native test fixture");
    await writeFile(good,content,{flag:"wx"});
    assert.equal(await sha256BoundedNativeArtifact(good),
      createHash("sha256").update(content).digest("hex"));

    // Create a sparse oversized file: test the pre-allocation size gate
    // without writing or loading 128 MiB of data into memory.
    const oversized=join(dir,"oversized.cwasm");
    const handle=await open(oversized,"wx");
    try{await handle.truncate(128*1024*1024+1)}finally{await handle.close()}
    await assert.rejects(sha256BoundedNativeArtifact(oversized),
      /native AOT artifact exceeds 128 MiB verification budget/);

    if(process.platform!=="win32"){
      const alias=join(dir,"native-link.cwasm");
      await symlink(good,alias);
      await assert.rejects(sha256BoundedNativeArtifact(alias),
        /symlink or special input file is forbidden/);
    }
  }finally{await rm(dir,{recursive:true,force:true})}
});

test("native AOT verifier refuses an unwritten FIFO without hanging",{
  skip:process.platform!=="linux"
},async()=>{
  const {spawnSync}=await import("node:child_process");
  const dir=await mkdtemp(join(tmpdir(),"oreslang-native-aot-fifo-"));
  try{
    const fifo=join(dir,"input.fifo");
    const created=spawnSync("mkfifo",[fifo],{timeout:3000,encoding:"utf8"});
    assert.equal(created.status,0,created.stderr);
    // The child timeout detects an accidentally blocking O_RDONLY open.
    const moduleUrl=new URL("../scripts/verify-real-aot.mjs",import.meta.url).href;
    const snippet="import {sha256BoundedNativeArtifact} from "+JSON.stringify(moduleUrl)+"; await sha256BoundedNativeArtifact(process.argv[1]);";
    const observed=spawnSync(process.execPath,["--input-type=module","-e",snippet,fifo],{
      timeout:3000,encoding:"utf8"
    });
    assert.equal(observed.error,undefined,
      "native AOT FIFO read must not wait for a writer: "+observed.error?.message);
    assert.equal(observed.status,1);
    assert.match(observed.stderr,/native AOT artifact exceeds 128 MiB verification budget/);
  }finally{await rm(dir,{recursive:true,force:true})}
});
