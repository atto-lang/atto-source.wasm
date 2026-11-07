import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, lstat, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {isAbsolute, join} from "node:path";
import {fileURLToPath} from "node:url";
import {compileOresToWasm, readBoundedRegularFile} from "../scripts/compile-ores.mjs";
import {readAtomicRelease} from "../scripts/atomic-release.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";

// Verified byte-identical on Java, LLVM and Wasm main on 2026-11-07.
// A matching source blob is not a compiler-backed parity pass.
const FIXTURES=Object.freeze([
  {name:"canonical-scalar",blob:"c86ac476e55074031c0bcda02f5eaf3cb1399477"},
  {name:"reject-fallthrough",blob:"1ff87aa95ed2537839347e80984c69ae46fdfa17"},
  {name:"reject-else",blob:"b2bbee98cd3b95ac19462b4efd95a2e98b469154"}
]);
const sha256=bytes=>createHash("sha256").update(bytes).digest("hex");
const gitBlob=bytes=>createHash("sha1")
  .update(Buffer.from("blob "+bytes.length+"\0","ascii")).update(bytes).digest("hex");
const required=process.env.ATTO_REQUIRE_GUARD_WASM_GUEST==="1";

function admitCompiler(env){
  if(!env.ORESLANG_LLVM_COMPILER||!isAbsolute(env.ORESLANG_LLVM_COMPILER))
    throw Error("guard v1 requires absolute native ORESLANG_LLVM_COMPILER");
  if(!/^[0-9a-f]{64}$/.test(env.ORESLANG_LLVM_COMPILER_SHA256||""))
    throw Error("guard v1 requires pinned ORESLANG_LLVM_COMPILER_SHA256");
  if(!/^[0-9a-f]{40}$/.test(env.ORESLANG_LLVM_SOURCE_SHA||""))
    throw Error("guard v1 requires reviewed ORESLANG_LLVM_SOURCE_SHA");
  return {compiler:env.ORESLANG_LLVM_COMPILER,
    compilerSha256:env.ORESLANG_LLVM_COMPILER_SHA256,
    llvmSourceSha:env.ORESLANG_LLVM_SOURCE_SHA};
}
async function readFixtures(){
  const sources=new Map();
  for(const item of FIXTURES){
    const path=fileURLToPath(new URL("../contracts/guard-v1/"+item.name+".atto",import.meta.url));
    const {bytes}=await readBoundedRegularFile(path,16384,"guard source exceeds 16 KiB");
    assert.equal(gitBlob(bytes),item.blob,item.name+": unreviewed shared source drift");
    assert.ok(bytes.length>0,item.name+": empty source");
    sources.set(item.name,{path,bytes,sourceSha256:sha256(bytes)});
  }
  return sources;
}
async function noPublishedArtifact(output){
  for(const path of [output,output+".current.json",output+".releases",
                     output+".artifact.json",output+".provenance.json"]){
    await assert.rejects(lstat(path),{code:"ENOENT"},
      "compiler rejection must not publish "+path);
  }
}
async function positive({compiler,compilerSha256,source,sourceSha256,output,expected,label,t}){
  const built=await compileOresToWasm({compiler,compilerSha256,source,output,
    environment:"browser",publication:"atomic"});
  const released=await readAtomicRelease(output);
  assert.equal(built.sourceSha256,sourceSha256,label+" source pin");
  assert.equal(built.compilerSha256,compilerSha256,label+" compiler pin");
  assert.equal(built.wasmSha256,sha256(released.wasm),label+" executable pin");
  assert.equal(released.provenance.sourceSha256,sourceSha256,label+" sealed source");
  assert.equal(released.provenance.compilerSha256,compilerSha256,label+" sealed compiler");
  assert.equal(released.manifest?.wasmSha256,built.wasmSha256,label+" manifest digest");
  assert.equal(released.manifest?.target,"wasm32",label+" target");
  assert.deepEqual(released.manifest?.imports,[],label+" host imports");
  assert.deepEqual(released.manifest?.requiredCapabilities,[],label+" host grants");
  assert.equal(released.manifest?.memory?.maximumPages,2,label+" memory bound");
  const observed=await runIsolatedCoreGuest(released.wasm,{
    expectedSha256:built.wasmSha256,timeoutMs:5000
  });
  assert.equal(observed.value,expected,label+" executed result");
  assert.equal(observed.admission.sha256,built.wasmSha256,label+" worker bytes");
  assert.equal(observed.admission.imports,0,label+" worker imports");
  assert.equal(observed.admission.hostCapabilities,0,label+" worker capabilities");
  t.diagnostic(JSON.stringify({kind:"executed-wasm-guest",label,
    sourceSha256,compilerSha256,wasmSha256:built.wasmSha256,value:String(observed.value)}));
}

test("guard-v1 source inventory is byte-pinned against Java and LLVM",async()=>{
  assert.equal((await readFixtures()).size,3);
});
test("guard-v1 required mode cannot skip missing compiler identity",()=>{
  assert.throws(()=>admitCompiler({}),/absolute native/);
  assert.throws(()=>admitCompiler({ORESLANG_LLVM_COMPILER:"/tmp/compiler"}),/pinned/);
  assert.throws(()=>admitCompiler({ORESLANG_LLVM_COMPILER:"/tmp/compiler",
    ORESLANG_LLVM_COMPILER_SHA256:"a".repeat(64)}),/reviewed/);
  assert.throws(()=>admitCompiler({ORESLANG_LLVM_COMPILER:"relative/compiler",
    ORESLANG_LLVM_COMPILER_SHA256:"a".repeat(64),
    ORESLANG_LLVM_SOURCE_SHA:"b".repeat(40)}),/absolute native/);
});

test("real LLVM .atto guard semantics execute through wasm32; invalid guards reject",{
  skip:!process.env.ORESLANG_LLVM_COMPILER&&!required,timeout:480000
},async t=>{
  const {compiler,compilerSha256,llvmSourceSha}=admitCompiler(process.env);
  const snapshot=(await readBoundedRegularFile(compiler,256*1024*1024,
    "native compiler exceeds executable budget")).bytes;
  assert.equal(sha256(snapshot),compilerSha256,"compiler bytes differ from pin");
  const sources=await readFixtures(),canonical=sources.get("canonical-scalar");
  const original=canonical.bytes.toString("utf8");
  const needle="return bounded(3);";
  assert.equal(original.split(needle).length,2,"canonical main expression changed");
  const dir=await mkdtemp(join(tmpdir(),"atto-guard-wasm-"));
  try{
    await positive({compiler,compilerSha256,source:canonical.path,
      sourceSha256:canonical.sourceSha256,output:join(dir,"canonical.wasm"),
      expected:42n,label:"canonical-scalar",t});
    // Derived Wasm-only behavioral probes; not independently reviewed shared
    // cross-backend fixture identities. Defeat constant-result compiler stubs.
    for(const {value,expected} of [
      {value:0,expected:1n},{value:-7,expected:1n},
      {value:5,expected:2n},{value:10,expected:2n},{value:9,expected:42n}
    ]){
      const name="guard-"+(value<0?"neg"+(-value):value);
      const bytes=Buffer.from(original.replace(needle,"return bounded("+value+");"),"utf8");
      const source=join(dir,name+".atto");
      await writeFile(source,bytes,{flag:"wx",mode:0o400});
      await positive({compiler,compilerSha256,source,sourceSha256:sha256(bytes),
        output:join(dir,name+".wasm"),expected,label:name,t});
    }
    let diagnosed=0;
    for(const name of ["reject-fallthrough","reject-else"]){
      const fixture=sources.get(name),output=join(dir,name+".wasm");
      await assert.rejects(compileOresToWasm({compiler,compilerSha256,
        source:fixture.path,output,environment:"browser",publication:"atomic"}),error=>{
          assert.equal(error.status,1,name+": reject through native compiler");
          assert.equal(error.signal,null,name+": do not count process crash");
          assert.equal(error.stdout,"",name+": no partial LLVM IR");
          assert.match(error.stderr||"",/^oreslang-llvmc:\s+\S/m,
            name+": require compiler-owned diagnostic");
          return true;
        });
      await noPublishedArtifact(output);
      diagnosed++;
      t.diagnostic(JSON.stringify({kind:"native-compiler-rejection",label:name,
        sourceSha256:fixture.sourceSha256,llvmSourceSha}));
    }
    assert.equal(diagnosed,2,"both invalid guard forms must reject");
    assert.equal((await readdir(dir)).filter(n=>n.startsWith(".oreslang-wasm-")).length,0,
      "compiler staging must be removed on rejection");
  }finally{await rm(dir,{recursive:true,force:true})}
});
