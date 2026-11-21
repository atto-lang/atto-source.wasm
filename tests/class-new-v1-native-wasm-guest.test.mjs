import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, lstat, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {isAbsolute, join} from "node:path";
import {fileURLToPath} from "node:url";
import {compileOresToWasm, readBoundedRegularFile} from "../scripts/compile-ores.mjs";
import {readAtomicRelease} from "../scripts/atomic-release.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";

// This pins an existing LLVM-compiler-backed source shape. Authored byte
// identity and host-only tests are NOT compiler-backed Wasm parity evidence.
const fixtureBlob="095fb5a5abe828f83facf9688819fe6c2e401aaa";
const originalName="new Pair(13)";
const sha256=b=>createHash("sha256").update(b).digest("hex");
const gitBlob=b=>createHash("sha1")
  .update(Buffer.from("blob "+b.length+"\0","ascii")).update(b).digest("hex");
const required=process.env.ATTO_REQUIRE_CLASS_NEW_WASM_GUEST==="1";

function compilerAdmission(env){
  if(!env.ORESLANG_LLVM_COMPILER||!isAbsolute(env.ORESLANG_LLVM_COMPILER))
    throw Error("class-new parity requires an absolute native ORESLANG_LLVM_COMPILER");
  if(!/^[0-9a-f]{64}$/.test(env.ORESLANG_LLVM_COMPILER_SHA256||""))
    throw Error("class-new parity requires pinned executable SHA-256");
  if(!/^[0-9a-f]{40}$/.test(env.ORESLANG_LLVM_SOURCE_SHA||""))
    throw Error("class-new parity requires independently reviewed LLVM source SHA");
  return {compiler:env.ORESLANG_LLVM_COMPILER,
    compilerSha256:env.ORESLANG_LLVM_COMPILER_SHA256,
    llvmSourceSha:env.ORESLANG_LLVM_SOURCE_SHA};
}

async function canonicalFixture(){
  const path=fileURLToPath(new URL("../contracts/class-new-v1/class-scalar-constructor.atto",import.meta.url));
  const oldPath=fileURLToPath(new URL("../examples/class-scalar-constructor.ores",import.meta.url));
  const [bytes,old]=(await Promise.all([path,oldPath].map(p=>
    readBoundedRegularFile(p,16384,"class source exceeds 16 KiB"))))
    .map(x=>x.bytes);
  assert.ok(bytes.length>0);
  assert.equal(gitBlob(bytes),fixtureBlob,"canonical .atto class source identity drift");
  assert.equal(gitBlob(old),fixtureBlob,"existing LLVM native Wasm example drift");
  assert.deepEqual(bytes,old,"canonical class .atto must exactly match legacy compiler fixture");
  const text=bytes.toString("utf8");
  assert.equal(text.split(originalName).length,2,"class-new positive constructor location drift");
  assert.match(text,/define class Pair as/);
  assert.match(text,/constructor\(int start\)/);
  return {path,bytes,text,sourceSha256:sha256(bytes)};
}

const positives=Object.freeze([
  {name:"canonical",replacement:"new Pair(13)",expected:40n},
  {name:"zero-input",replacement:"new Pair(0)",expected:1n},
  {name:"twenty-one",replacement:"new Pair(21)",expected:64n},
  {name:"forty-one",replacement:"new Pair(41)",expected:124n}
]);
const negatives=Object.freeze([
  {name:"missing-new",replacement:"Pair(13)",diagnostic:/new|constructor|unknown function Pair|class.+call/i},
  {name:"missing-arg",replacement:"new Pair()",diagnostic:/constructor|arity|argument/i},
  {name:"extra-arg",replacement:"new Pair(13, 2)",diagnostic:/constructor|arity|argument/i}
]);

async function noPublication(output){
  for(const file of [output,output+".current.json",output+".releases",
                     output+".provenance.json",output+".artifact.json"]){
    await assert.rejects(lstat(file),{code:"ENOENT"},
      "rejected constructor must not publish "+file);
  }
}
async function executedGuest({compiler,compilerSha256,source,output,
  sourceSha256,expected,name,t}){
  const built=await compileOresToWasm({
    compiler,compilerSha256,source,output,environment:"browser",publication:"atomic"
  });
  const released=await readAtomicRelease(output);
  assert.equal(built.compilerSha256,compilerSha256,name+" pinned compiler");
  assert.equal(built.sourceSha256,sourceSha256,name+" source identity");
  assert.equal(built.wasmSha256,sha256(released.wasm),name+" compiled guest bytes");
  assert.equal(released.provenance?.sourceSha256,sourceSha256,name+" sealed source");
  assert.equal(released.provenance?.compilerSha256,compilerSha256,name+" sealed compiler");
  assert.equal(released.manifest?.producer?.llvmIrSha256,built.llvmIrSha256,name+" IR provenance");
  assert.equal(released.manifest?.wasmSha256,built.wasmSha256,name+" sealed Wasm");
  assert.equal(released.manifest?.target,"wasm32");
  assert.equal(released.manifest?.memory?.maximumPages,2);
  assert.deepEqual(released.manifest?.imports,[]);
  assert.deepEqual(released.manifest?.requiredCapabilities,[]);
  const observed=await runIsolatedCoreGuest(released.wasm,{
    expectedSha256:built.wasmSha256,timeoutMs:5000
  });
  assert.equal(observed.value,expected,name+" genuine compiled guest result");
  assert.equal(observed.admission.sha256,built.wasmSha256);
  assert.equal(observed.admission.imports,0);
  assert.equal(observed.admission.hostCapabilities,0);
  t.diagnostic(JSON.stringify({kind:"executed-class-new-wasm",
    case:name,value:String(observed.value),sourceSha256,
    compilerSha256,wasmSha256:built.wasmSha256}));
}

test("canonical class-new .atto fixture is byte-identical to existing LLVM example",async()=>{
  await canonicalFixture();
});

test("required class-new Wasm parity refuses untrusted compiler inputs",()=>{
  assert.throws(()=>compilerAdmission({}),/absolute native/);
  assert.throws(()=>compilerAdmission({ORESLANG_LLVM_COMPILER:"relative/path"}),/absolute native/);
  assert.throws(()=>compilerAdmission({ORESLANG_LLVM_COMPILER:"/compiler"}),/pinned executable/);
  assert.throws(()=>compilerAdmission({
    ORESLANG_LLVM_COMPILER:"/compiler",ORESLANG_LLVM_COMPILER_SHA256:"a".repeat(64)
  }),/reviewed LLVM/);
});

test("real LLVM frontend emits new-only class constructor Wasm and rejects bad calls",{
  skip:!process.env.ORESLANG_LLVM_COMPILER&&!required,
  timeout:480000
},async t=>{
  const {compiler,compilerSha256,llvmSourceSha}=compilerAdmission(process.env);
  const bytes=(await readBoundedRegularFile(compiler,256*1024*1024,
    "class-new native LLVM compiler exceeds executable budget")).bytes;
  assert.equal(sha256(bytes),compilerSha256,"native LLVM executable bytes differ from pin");
  const fixture=await canonicalFixture();
  const dir=await mkdtemp(join(tmpdir(),"atto-class-new-wasm-"));
  try{
    for(const item of positives){
      const source=join(dir,item.name+".atto"),output=join(dir,item.name+".wasm");
      const bytes=Buffer.from(fixture.text.replace(originalName,item.replacement),"utf8");
      await writeFile(source,bytes,{flag:"wx",mode:0o400});
      await executedGuest({compiler,compilerSha256,source,output,
        sourceSha256:sha256(bytes),expected:item.expected,name:item.name,t});
    }
    for(const item of negatives){
      const source=join(dir,item.name+".atto"),output=join(dir,item.name+".wasm");
      const bytes=Buffer.from(fixture.text.replace(originalName,item.replacement),"utf8");
      await writeFile(source,bytes,{flag:"wx",mode:0o400});
      await assert.rejects(compileOresToWasm({
        compiler,compilerSha256,source,output,environment:"browser",publication:"atomic"
      }),error=>{
        assert.equal(error.status,1,item.name+" requires native semantic rejection");
        assert.equal(error.signal,null,item.name+" compiler must not crash");
        assert.equal(error.stdout,"",item.name+" no partial LLVM IR");
        assert.match(error.stderr||"",/^oreslang-llvmc:\s+\S/m,
          item.name+" compiler-owned diagnostic");
        assert.match(error.stderr||"",item.diagnostic,
          item.name+" must reject for constructor semantics");
        return true;
      });
      await noPublication(output);
      t.diagnostic(JSON.stringify({kind:"compiler-rejected-class-call",
        case:item.name,sourceSha256:sha256(bytes),llvmSourceSha}));
    }
    assert.equal(positives.length,4);
    assert.equal(negatives.length,3);
  }finally{await rm(dir,{recursive:true,force:true})}
});
