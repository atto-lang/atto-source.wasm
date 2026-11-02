// Real native Oreslang source -> linked Wasm -> both Node and Wasmtime AOT.
// Development-only verifier: Wasmtime's unsafe deserializer must remain off
// in ordinary debug and ALL release binaries.
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdtemp,readFile,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve,join,isAbsolute} from "node:path";
import {fileURLToPath} from "node:url";
import {compileOresToWasm,readBoundedRegularFile} from "./compile-ores.mjs";
import {readAtomicRelease} from "./atomic-release.mjs";
import {cleanupRealCompilerWorkspace} from "./cleanup-real-compiler.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";

const sha256=bytes=>createHash("sha256").update(bytes).digest("hex");
const MAX_NATIVE_AOT_BYTES=128*1024*1024;
// The native builder has a 128 MiB output budget. A successful exit code is
// not permission for the verifier to eagerly read a bigger or special file.
// Open and hash the same bounded, no-follow snapshot used at admission.
export async function sha256BoundedNativeArtifact(path) {
  const {bytes}=await readBoundedRegularFile(path,MAX_NATIVE_AOT_BYTES,
    "native AOT artifact exceeds 128 MiB verification budget");
  return sha256(bytes);
}

const root=resolve(fileURLToPath(new URL("..",import.meta.url)));
const fixtures=[
  ["native-int", "42"],
  ["forward-call", "47"],
  ["return-arithmetic", "28"],
  ["negative-result", "-5"],
  ["zero-result", "0"],
  ["class-scalar-constructor", "40"]
];
function invoke(executable,args,expectedSuccess=true) {
  const r=spawnSync(executable,args,{
    encoding:"utf8",timeout:30000,maxBuffer:4*1024*1024,
    env:{PATH:process.env.PATH||"/usr/bin:/bin",HOME:process.env.HOME||"/tmp"}
  });
  if(r.error||r.signal)throw Error("native subprocess did not terminate normally: "+(r.error?.message||r.signal));
  if(expectedSuccess && r.status!==0)
    throw Error("native subprocess failed: "+String(r.stderr||r.stdout).slice(0,1500));
  if(!expectedSuccess && r.status===0)throw Error("untrusted artifact was admitted");
  return r;
}
export async function verifyRealSourceToAot({
  compiler=process.env.ATTOLANG_LLVM_COMPILER || process.env.ORESLANG_LLVM_COMPILER,
  compilerSha256=process.env.ATTOLANG_LLVM_COMPILER_SHA256 || process.env.ORESLANG_LLVM_COMPILER_SHA256,
  llvmSourceSha=process.env.ATTOLANG_LLVM_SOURCE_SHA || process.env.ORESLANG_LLVM_SOURCE_SHA,
  builder=process.env.ORESLANG_AOT_BUILDER,
  builderSha256=process.env.ORESLANG_AOT_BUILDER_SHA256,
  runner=process.env.ORESLANG_AOT_DEV_RUNNER,
  runnerSha256=process.env.ORESLANG_AOT_DEV_RUNNER_SHA256
}={}) {
  if(![compiler,builder,runner].every(p=>typeof p==="string"&&isAbsolute(p)))
    throw Error("absolute ATTOLANG_LLVM_COMPILER (legacy ORESLANG alias accepted), ORESLANG_AOT_BUILDER and ORESLANG_AOT_DEV_RUNNER paths required");
  if(!/^[a-f0-9]{64}$/.test(compilerSha256||"")||!/^[a-f0-9]{40}$/.test(llvmSourceSha||""))
    throw Error("pinned LLVM compiler binary and source commit SHAs are required");
  if(!/^[a-f0-9]{64}$/.test(builderSha256||"")||!/^[a-f0-9]{64}$/.test(runnerSha256||""))
    throw Error("pinned AOT builder and development runner SHA-256 values are required");
  const binary=(await readBoundedRegularFile(compiler,256*1024*1024)).bytes;
  if(sha256(binary)!==compilerSha256)throw Error("native AttoLang compiler digest mismatch");
  // Verify the exact AOT tools independently. A caller-selected path and
  // its self-reported output are not evidence that Wasmtime executed.
  const builderBytes=(await readBoundedRegularFile(builder,256*1024*1024)).bytes;
  if(sha256(builderBytes)!==builderSha256)throw Error("native AOT builder digest mismatch");
  const runnerBytes=(await readBoundedRegularFile(runner,256*1024*1024)).bytes;
  if(sha256(runnerBytes)!==runnerSha256)throw Error("native AOT runner digest mismatch");
  const tmp=await mkdtemp(join(tmpdir(),"oreslang-real-source-aot-"));
  let primaryError;
  try {
    // Execute the bytes already verified above, not mutable caller-owned
    // paths. The workspace is a private mkdtemp directory. Production
    // authenticity still requires independent approval and OS isolation.
    const pinnedBuilder=join(tmp,"pinned-aot-builder");
    const pinnedRunner=join(tmp,"pinned-aot-runner");
    await writeFile(pinnedBuilder,builderBytes,{flag:"wx",mode:0o500});
    await writeFile(pinnedRunner,runnerBytes,{flag:"wx",mode:0o500});
    const results=[];
    for(const [name,expected] of fixtures) {
      const source=join(root,"examples",name+".atto");
      const output=join(tmp,name+".wasm");
      const published=await compileOresToWasm({
        compiler,compilerSha256,source,output,environment:"browser",publication:"atomic"
      });
      const release=await readAtomicRelease(output);
      const wasm=release.wasm;
      const pin=sha256(wasm);
      assert.equal(published.wasmSha256,pin,"compiler and published Wasm digest must match");
      assert.equal(release.manifest.wasmSha256,pin,"manifest must bind exact Wasm bytes");
      assert.equal(release.manifest.producer.compilerSha256,compilerSha256);
      assert.equal(release.manifest.producer.sourceSha256,sha256(await readFile(source)));
      assert.deepEqual(release.manifest.requiredCapabilities,[]);
      assert.deepEqual(release.manifest.imports,[]);
      const js=await runIsolatedCoreGuest(wasm,{expectedSha256:pin,timeoutMs:5000});
      assert.equal(String(js.value),expected,"real AttoLang Node guest mismatch: "+name);
      assert.equal(js.admission.sha256,pin);
      const raw=join(tmp,name+".raw.wasm"),native=join(tmp,name+".cwasm");
      await writeFile(raw,wasm,{flag:"wx",mode:0o400});
      const builderResult=invoke(pinnedBuilder,[raw,pin,native]);
      const match=/^aot_sha256=([a-f0-9]{64})$/m.exec(builderResult.stdout);
      if(!match)throw Error("native AOT builder did not emit SHA-256: "+name);
      const nativeSha=await sha256BoundedNativeArtifact(native);
      assert.equal(match[1],nativeSha,"native artifact integrity mismatch");
      const executed=invoke(pinnedRunner,[native,nativeSha]);
      assert.equal(executed.stdout.trim(),expected,"real AttoLang AOT result mismatch: "+name);
      // Reject caller tampering with an otherwise valid native artifact.
      assert.match(invoke(pinnedRunner,[native,"0".repeat(64)],false).stderr,/AOT bytes do not match insecure development digest/);
      // Correct SHA must not make raw WebAssembly acceptable to the AOT loader.
      assert.match(invoke(pinnedRunner,[raw,pin],false).stderr,/approved bytes are not a precompiled core Wasm module/);
      results.push({fixture:name,node:expected,aot:executed.stdout.trim(),wasmSha256:pin});
    }
    return {status:"verified-dev-only",llvmSourceSha,compilerSha256,builderSha256,runnerSha256,fixtures:results};
  } catch(error){primaryError=error;throw error}
  finally {
    try{await cleanupRealCompilerWorkspace(tmp)}
    catch(error){
      if(primaryError) primaryError.cleanupFailure=String(error?.message||error).slice(0,256);
      else throw error;
    }
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{console.log(JSON.stringify(await verifyRealSourceToAot(),null,2))}
  catch(error){console.error("Real-source-AOT gate FAILED: "+String(error?.message||error));process.exitCode=1}
}
