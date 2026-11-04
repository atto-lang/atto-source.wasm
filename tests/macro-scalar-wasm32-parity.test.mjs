// Shared AttoLang macro scalar intersection: LLVM production compiler ->
// wasm32 LLVM IR -> clang/lld -> bounded Wasm -> isolated guest. This is NOT
// a JS macro interpreter. Static fixture checks are not guest evidence.
import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {readFile,writeFile,mkdtemp,rm,stat,realpath} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,isAbsolute} from "node:path";
import {fileURLToPath} from "node:url";
import {compileOresToWasm,readBoundedRegularFile} from "../scripts/compile-ores.mjs";
import {readAtomicRelease} from "../scripts/atomic-release.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";
import {requiresMacroWasm32Guest} from "../scripts/macro-wasm32-guest-gate.mjs";

const root=fileURLToPath(new URL("../",import.meta.url));
const fixtures=Object.freeze([
  {
    "name": "identity-42",
    "blob": "ae9c9236fafbd23ce68becf10bde919e9ff25557",
    "kind": "pass",
    "diag": null
  },
  {
    "name": "literal-42",
    "blob": "27f4a4625bd991987d8f3fa5c330feeb6b534ad7",
    "kind": "pass",
    "diag": null
  },
  {
    "name": "nested-42",
    "blob": "0f94796b9cd9c7627017131194c733531efe7ecd",
    "kind": "pass",
    "diag": null
  },
  {
    "name": "template-twice-42",
    "blob": "fbe876e0a4577c9e6bc04e348697cc7dd6949b44",
    "kind": "pass",
    "diag": null
  },
  {
    "name": "template-twice-nested-42",
    "blob": "671c7a80f7506e3b6180f08b21bd51dbf2e924b5",
    "kind": "pass",
    "diag": null
  },
  {
    "name": "arithmetic-42",
    "blob": "5a178e168982dcebd544c2aa3cc5c530742c927b",
    "kind": "pass",
    "diag": null
  },
  {
    "name": "identity-expression-42",
    "blob": "3e8944c670e2ab4b2fb670eae62e755531c142df",
    "kind": "pass",
    "diag": null
  },
  {
    "name": "overflow-reject",
    "blob": "1bd57f26d9ac8135531638f4d8a6a786ed7ec7bc",
    "kind": "reject",
    "diag": "NATIVE_MACRO_CONST_OVERFLOW"
  },
  {
    "name": "wrong-kind-reject",
    "blob": "895555ea01a6b0480ce7fa130d1aad44815ac971",
    "kind": "reject",
    "diag": "NATIVE_MACRO_EXPANDER_REQUIRED"
  },
  {
    "name": "runtime-const-reject",
    "blob": "c13c4d2d08395cb535265f6eaa9a454bdef4dd10",
    "kind": "reject",
    "diag": "NATIVE_MACRO_CONST_UNCLOSED"
  },
  {
    "name": "unresolved-reject",
    "blob": "b6d2570d0bf7bd2b532cdb306690f24861db164a",
    "kind": "reject",
    "diag": "NATIVE_MACRO_EXPANDER_REQUIRED"
  },
  {
    "name": "template-twice-overflow-reject",
    "blob": "823a06f928bf416cc7f311595df88e085b33b2c2",
    "kind": "reject",
    "diag": "NATIVE_MACRO_CONST_OVERFLOW"
  },
  {
    "name": "template-twice-composite-reject",
    "blob": "2beb01a9a71cc19463248cf767ef9a5a3f62595e",
    "kind": "reject",
    "diag": "NATIVE_MACRO_EXPANDER_REQUIRED"
  },
  {
    "name": "template-twice-name-reject",
    "blob": "098d0084845089c70430b2f1b7df5a2edb73a049",
    "kind": "reject",
    "diag": "NATIVE_MACRO_EXPANDER_REQUIRED"
  },
  {
    "name": "unused-template-mismatch-reject",
    "blob": "a2ee7fe932ba4ce2319457ef0796dcff279b823f",
    "kind": "reject",
    "diag": "NATIVE_MACRO_EXPANDER_REQUIRED"
  },
  {
    "name": "unary-overflow-reject",
    "blob": "ad3a4b963ffc9c3ee21c9405f516c3b82c2b51b2",
    "kind": "reject",
    "diag": "NATIVE_MACRO_CONST_OVERFLOW"
  }
]);
const sourceDir=join(root,"tests","fixtures","macro-scalar-v1");
const reviewedLlvmHead="b83f540269a256e549cc9160b6b43bf37d33fb0f";
const reviewedLlvmTree="26e85b258061b206e4a145825df6dfe11065a499";
const sha256=bytes=>createHash("sha256").update(bytes).digest("hex");
const blobSha=bytes=>createHash("sha1")
    .update(Buffer.from("blob "+bytes.length+"\0")).update(bytes).digest("hex");
const missing=async path=>assert.rejects(stat(path),{code:"ENOENT"});
const git=(args,cwd=root)=> {
 const p=spawnSync("git",args,{cwd,encoding:"utf8",timeout:5000,
   env:{PATH:process.env.PATH||"/usr/bin:/bin",LANG:"C",LC_ALL:"C"}});
 assert.ifError(p.error);
 assert.equal(p.status,0,"git "+args.join(" ")+": "+p.stderr);
 return p.stdout.trim();
};

test("16 byte-identical .NET/LLVM/Wasm stage-0 fixtures are pinned, source-only",async()=>{
 assert.equal(fixtures.length,16);
 assert.equal(fixtures.filter(f=>f.kind==="pass").length,7);
 assert.equal(fixtures.filter(f=>f.kind==="reject").length,9);
 const observed=new Set();
 for(const f of fixtures){
  assert.equal(observed.has(f.name),false,"duplicate fixture");observed.add(f.name);
  assert.match(f.blob,/^[0-9a-f]{40}$/);
  const bytes=await readFile(join(sourceDir,f.name+".atto"));
  assert.equal(blobSha(bytes),f.blob,f.name+" Git blob/source drift");
  assert.ok(bytes.length>0&&bytes.length<=1048576);
  assert.ok(bytes.toString("utf8").includes("fnc main()"),f.name);
  if(f.kind==="reject")assert.match(f.diag,/^NATIVE_MACRO_/);
 }
 // No execution marker is emitted here: this is deliberately source only.
});

const demanded=requiresMacroWasm32Guest(process.env);
test("real reviewed LLVM macro compiler links and executes seven Wasm32 guests and rejects nine",{
 skip:!demanded,timeout:900000
},async()=>{
 const expectedWasm=process.env.ORESLANG_MACRO_WASM_EXPECTED_HEAD;
 assert.match(expectedWasm||"",/^[0-9a-f]{40}$/,"pin exact Wasm source HEAD");
 assert.equal(git(["rev-parse","HEAD"]),expectedWasm,"Wasm checkout is not reviewed exact head");
 const wasmTree=git(["rev-parse","HEAD^{tree}"]);
 assert.equal(git(["status","--porcelain","--untracked-files=no"]),"","dirty tracked Wasm source");
 assert.equal(process.env.ORESLANG_LLVM_SOURCE_SHA,reviewedLlvmHead,
  "LLVM macro compiler source SHA must match reviewed scalar parser");
 assert.equal(process.env.ORESLANG_LLVM_SOURCE_TREE,reviewedLlvmTree,
  "LLVM source tree mismatch");
 // An environment string alone does not prove a native compiler's origin.
 // Require the exact local LLVM source checkout in addition to the reviewed
 // SHA/tree and compiler binary digest. The caller must still bind its build
 // job to this checkout; no external/private cross-org source export occurs.
 const llvmRoot=process.env.ORESLANG_LLVM_SOURCE_ROOT;
 assert.ok(llvmRoot&&isAbsolute(llvmRoot),"absolute authorized LLVM source checkout required");
 const llvmPath=await realpath(llvmRoot);
 assert.equal(git(["rev-parse","HEAD"],llvmPath),reviewedLlvmHead,
   "live LLVM checkout does not match reviewed compiler source head");
 assert.equal(git(["rev-parse","HEAD^{tree}"],llvmPath),reviewedLlvmTree,
   "live LLVM checkout does not match reviewed source tree");
 assert.equal(git(["status","--porcelain","--untracked-files=no"],llvmPath),"",
   "dirty tracked LLVM compiler source");
 const linkerRequested=process.env.CLANG;
 const linkerDigest=process.env.ORESLANG_MACRO_WASM_CLANG_SHA256;
 assert.ok(linkerRequested&&isAbsolute(linkerRequested),
   "absolute reviewed clang/lld executable required");
 assert.match(linkerDigest||"",/^[0-9a-f]{64}$/,"pinned clang executable SHA-256 required");
 const linker=await realpath(linkerRequested);
 const linkerBytes=(await readBoundedRegularFile(linker,256*1024*1024,
   "clang executable exceeds byte budget")).bytes;
 assert.equal(sha256(linkerBytes),linkerDigest,"clang/lld toolchain binary mismatch");
 const compiler=process.env.ORESLANG_LLVM_COMPILER;
 const compilerSha=process.env.ORESLANG_LLVM_COMPILER_SHA256;
 assert.ok(compiler&&isAbsolute(compiler),"approved absolute LLVM compiler path required");
 assert.match(compilerSha||"",/^[0-9a-f]{64}$/,"binary digest required");
 const pinned=(await readBoundedRegularFile(compiler,256*1024*1024,
   "native compiler exceeds byte budget")).bytes;
 assert.equal(sha256(pinned),compilerSha,"LLVM compiler bytes changed");
 const scratch=await mkdtemp(join(tmpdir(),"atto-macro-wasm32-"));
 let positiveCount=0,negativeCount=0;
 try{
  for(const f of fixtures){
   const source=join(scratch,f.name+".atto");
   const output=join(scratch,f.name+".wasm");
   const bytes=await readFile(join(sourceDir,f.name+".atto"));
   assert.equal(blobSha(bytes),f.blob);
   await writeFile(source,bytes,{mode:0o400,flag:"wx"});
   if(f.kind==="pass"){
    const built=await compileOresToWasm({compiler,compilerSha256:compilerSha,
     clang:linker,source,output,environment:"browser",publication:"atomic"});
    const release=await readAtomicRelease(output);
    assert.equal(built.sourceSha256,sha256(bytes));
    assert.equal(built.compilerSha256,compilerSha);
    assert.equal(built.wasmSha256,sha256(release.wasm));
    assert.deepEqual(release.manifest.imports,[]);
    assert.deepEqual(release.manifest.requiredCapabilities,[]);
    const guest=await runIsolatedCoreGuest(release.wasm,{
      expectedSha256:built.wasmSha256,timeoutMs:5000
    });
    assert.equal(guest.value,42n,f.name+" guest value");
    assert.equal(guest.admission.hostCapabilities,0);
    assert.equal(guest.admission.imports,0);
    positiveCount++;
    console.log("MACRO_WASM32_GUEST_PASS fixture="+f.name+" value=42 source_sha256="+
      sha256(bytes)+" compiler_sha256="+compilerSha+" wasm_sha256="+built.wasmSha256+
      " wasm_head="+expectedWasm+" wasm_tree="+wasmTree+
      " llvm_head="+reviewedLlvmHead+" clang_sha256="+linkerDigest);
   }else{
    await assert.rejects(
      compileOresToWasm({compiler,compilerSha256:compilerSha,
        clang:linker,source,output,environment:"browser",publication:"atomic"}),
      e=>{
       assert.equal(e?.status,1,"negative requires typed compiler exit 1");
       assert.equal(e?.signal,null,"negative compiler killed");
       assert.equal(e?.stdout||"","","negative compiler leaked LLVM IR");
       assert.ok(String(e?.message||"").includes(f.diag),
         "wrong macro rejection: "+String(e?.message||"").slice(0,300));
       return true;
      },f.name+" unexpected compilation success");
    for(const path of [output,output+".artifact.json",output+".provenance.json",
       output+".current.json",output+".releases"])await missing(path);
    negativeCount++;
    console.log("MACRO_WASM32_REJECTION_PASS fixture="+f.name+
      " diagnostic="+f.diag+" source_sha256="+sha256(bytes));
   }
  }
  assert.equal(positiveCount,7,"missing native guest receipts");
  assert.equal(negativeCount,9,"missing source rejection receipts");
  assert.equal(git(["rev-parse","HEAD"]),expectedWasm,"Wasm tree moved during execution");
  assert.equal(git(["status","--porcelain","--untracked-files=no"]),"","dirty source after tests");
  assert.equal(git(["rev-parse","HEAD"],llvmPath),reviewedLlvmHead,"LLVM HEAD moved");
  assert.equal(git(["rev-parse","HEAD^{tree}"],llvmPath),reviewedLlvmTree,"LLVM tree moved");
  assert.equal(git(["status","--porcelain","--untracked-files=no"],llvmPath),"",
    "LLVM source changed while compiling");
  assert.equal(sha256((await readBoundedRegularFile(compiler,256*1024*1024,
     "compiler changed")).bytes),compilerSha);
  assert.equal(sha256((await readBoundedRegularFile(linker,256*1024*1024,
     "linker changed")).bytes),linkerDigest);
  console.log("MACRO_WASM32_EXACT_SOURCE_GUEST_GATE_PASS guests="+positiveCount+
    " rejections="+negativeCount+" wasm_head="+expectedWasm+
    " llvm_head="+reviewedLlvmHead);
 }finally{await rm(scratch,{recursive:true,force:true});}
});
