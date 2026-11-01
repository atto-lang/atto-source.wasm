import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,isAbsolute} from "node:path";
import {createHash} from "node:crypto";
import {compileOresToWasm} from "../scripts/compile-ores.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";

// Exact UTF-8/LF source bytes from platform-conformance/fixtures/proxy-lb-v1.
// Source-only blob checks always run. Guest tests require an actual pinned
// native llvmc and never fall back to synthetic Wasm modules or JS arithmetic.
const vectors=[
  ["comparison-positive","9*1-1*3",6n,"885b62c32ea5f25a7223afd166a78ba60642dde7"],
  ["comparison-negative","2*1-1*3",-1n,"9e9a6c048367dc52dda7948072920717d3e8d357"],
  ["comparison-tie","3*1-1*3",0n,"b100715d0a8544e13ad8d88bf44a7fced72f24dd"],
  ["comparison-max-balanced","1024*16-1024*16",0n,"1195e932ce4e128b0d109bf3715afbc82d85b567"],
  ["comparison-max-positive","1024*16-0*16",16384n,"23a9c6371e252ff4e1ffbeed87f05238e9268296"],
];
const gitBlob=source=>createHash("sha1")
  .update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest("hex");
const sourceFor=expression=>`fnc main():int{return ${expression};}\n`;
const sha256=bytes=>createHash("sha256").update(bytes).digest("hex");

test("proxy LB scalar sources retain exact shared Git blob identities",()=>{
  for(const [name,expression,,sha] of vectors)
    assert.equal(gitBlob(sourceFor(expression)),sha,name);
});

test("actual isolated Wasm guest executes proxy LB signed-i64 scalar corpus",async t=>{
  const compiler=process.env.ORESLANG_LLVM_COMPILER;
  const compilerSha256=process.env.ORESLANG_LLVM_COMPILER_SHA256;
  if (!compiler || !compilerSha256) {
    t.skip("NOT_EXECUTED: requires absolute pinned ORESLANG_LLVM_COMPILER + SHA256");
    return;
  }
  assert.ok(isAbsolute(compiler),"compiler must be an absolute path");
  assert.match(compilerSha256,/^[a-f0-9]{64}$/);
  const dir=await mkdtemp(join(tmpdir(),"ores-proxy-lb-wasm-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  for(const [name,expression,expected,gitSha] of vectors){
    const source=join(dir,name+".ores");
    const output=join(dir,name+".wasm");
    await writeFile(source,sourceFor(expression),{flag:"wx",mode:0o400});
    assert.equal(gitBlob(await readFile(source)),gitSha);
    await compileOresToWasm({compiler,compilerSha256,source,output});
    const wasm=await readFile(output);
    const observed=await runIsolatedCoreGuest(wasm,{
      expectedSha256:sha256(wasm),timeoutMs:5000
    });
    assert.equal(observed.value,expected,"Wasm guest mismatch: "+name);
  }
  // This backend's zero-import core host cannot forward packets or serve
  // an Oreslang actor module. A compiler that merely emits a stub would be
  // a dangerous false-positive: require outright rejection and no artifact.
  const unsupportedSource=join(dir,"unsupported-proxy.ores");
  const unsupportedWasm=join(dir,"unsupported-proxy.wasm");
  await writeFile(unsupportedSource,"define module proxy_lb as end\\n",
    {flag:"wx",mode:0o400});
  await assert.rejects(()=>compileOresToWasm({
    compiler,compilerSha256,source:unsupportedSource,output:unsupportedWasm
  }));
  await assert.rejects(()=>readFile(unsupportedWasm));
});
