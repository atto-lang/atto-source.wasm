import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp,readFile,writeFile,rm,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,isAbsolute} from "node:path";
import {compileOresToWasm,readBoundedRegularFile} from "../scripts/compile-ores.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";
import {readAtomicRelease} from "../scripts/atomic-release.mjs";

// This is a separate release gate, not host-only f64 proof. A compiler must
// have its independently reviewed source-to-binary provenance attested elsewhere.
test("pinned real AttoLang LLVM float source compiles and executes in a Wasm worker",{
  skip:process.env.ORESLANG_F64_PARITY_REQUIRED!=="1",
  timeout:120000
},async()=>{
  const compiler=process.env.ORESLANG_LLVM_COMPILER;
  const pin=process.env.ORESLANG_LLVM_COMPILER_SHA256;
  const sourceSha=process.env.ORESLANG_LLVM_SOURCE_SHA;
  assert.ok(compiler,"required f64 source parity cannot skip without a real LLVM compiler");
  assert.match(pin||"",/^[0-9a-f]{64}$/,"real f64 compiler binary must be SHA-256 pinned");
  assert.match(sourceSha||"",/^[0-9a-f]{40}$/,"real f64 compiler must be linked to a reviewed source head");
  const snap=await readBoundedRegularFile(compiler,256*1024*1024);
  assert.equal(createHash("sha256").update(snap.bytes).digest("hex"),pin);
  const dir=await mkdtemp(join(tmpdir(),"atto-f64-real-guest-"));
  try{
    const source=join(dir,"main.atto"),output=join(dir,"float.wasm");
    const positive="pub fnc main(): float { return 1.5 + 2.25; }\n";
    await writeFile(source,positive);
    const built=await compileOresToWasm({compiler,compilerSha256:pin,source,output,
      profile:"core-wasm.f64-v1",environment:"browser",publication:"atomic"});
    assert.equal(built.profile,"core-wasm.f64-v1");
    assert.equal(built.sourceSha256,createHash("sha256").update(positive).digest("hex"));
    const released=await readAtomicRelease(output);
    assert.equal(released.manifest.artifactType,"oreslang.core-wasm.f64-v1");
    assert.equal(released.manifest.producer.compilerSha256,pin);
    assert.equal(released.manifest.requiredCapabilities.length,0);
    const executed=await runIsolatedCoreGuest(released.wasm,{
      profile:"core-wasm.f64-v1",expectedSha256:built.wasmSha256,timeoutMs:5000});
    assert.equal(executed.value,3.75);
    assert.equal(executed.admission.imports,0);
    assert.equal(executed.admission.hostCapabilities,0);
    // An i64 source MUST NOT be published under the binary64 ABI.
    const invalidOutput=join(dir,"wrong-type.wasm");
    await writeFile(source,"pub fnc main(): int { return 42; }\n");
    await assert.rejects(()=>compileOresToWasm({
      compiler,compilerSha256:pin,source,output:invalidOutput,
      profile:"core-wasm.f64-v1",environment:"browser",publication:"atomic"
    }),/expected double|exact \(\) -> f64/);
    await assert.rejects(stat(invalidOutput+".current.json"),{code:"ENOENT"});
    assert.equal((await readAtomicRelease(output)).releaseSha256,released.releaseSha256);
    // Emit an execution-bound receipt only AFTER the real source-compiled
    // binary returned 3.75 in a disposable Worker, and wrong-type publication
    // failed. A bridge stub cannot populate this receipt.
    if(process.env.ORESLANG_F64_GUEST_EVIDENCE_PATH!==undefined){
      const evidencePath=process.env.ORESLANG_F64_GUEST_EVIDENCE_PATH;
      assert.ok(isAbsolute(evidencePath),"guest evidence path must be absolute");
      const evidence={
        schema:"atto-f64-wasm-worker-v1",
        compilerSha256:pin,
        sourceSha256:built.sourceSha256,
        wasmSha256:built.wasmSha256,
        releaseSha256:released.releaseSha256,
        profile:"core-wasm.f64-v1",entry:"main",value:executed.value,
        hostImports:executed.admission.imports,
        hostCapabilities:executed.admission.hostCapabilities,
        negativeNoPublication:true,execution:"EXECUTED",
        certification:"NOT_CERTIFIED"
      };
      await writeFile(evidencePath,JSON.stringify(evidence,null,2)+"\\n",
        {flag:"wx",mode:0o600});
    }
  } finally {await rm(dir,{recursive:true,force:true});}
});
