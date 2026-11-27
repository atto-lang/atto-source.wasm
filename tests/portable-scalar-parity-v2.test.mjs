import {assertNativeRemovedPercent} from '../scripts/assert-native-percent-denial.mjs';
import {cleanupRealCompilerWorkspace} from '../scripts/cleanup-real-compiler.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, readFile, writeFile, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, isAbsolute} from "node:path";
import {compileOresToWasm, readBoundedRegularFile} from "../scripts/compile-ores.mjs";
import {readAtomicRelease} from "../scripts/atomic-release.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";

const manifestUrl=new URL("../contracts/parity/portable-scalar-v2-20261101.json",import.meta.url);
const reviewedBlobSha="d12f124afbe3d9a865bd7f84ccf24c7f37a8644b";
const sha256=bytes=>createHash("sha256").update(bytes).digest("hex");
const sourceFor=expression=>"pub fnc main():int{return "+expression+";}\n";
const required=process.env.ORESLANG_SCALAR_PARITY_REQUIRED==="1";

function admitCompiler(env){
  if(!env.ORESLANG_LLVM_COMPILER || !isAbsolute(env.ORESLANG_LLVM_COMPILER))
    throw Error("portable scalar parity requires a real absolute ORESLANG_LLVM_COMPILER path");
  if(!/^[0-9a-f]{64}$/.test(env.ORESLANG_LLVM_COMPILER_SHA256||""))
    throw Error("portable scalar parity requires pinned ORESLANG_LLVM_COMPILER_SHA256");
  if(!/^[0-9a-f]{40}$/.test(env.ORESLANG_LLVM_SOURCE_SHA||""))
    throw Error("portable scalar parity requires independently reviewed ORESLANG_LLVM_SOURCE_SHA");
  return {compiler:env.ORESLANG_LLVM_COMPILER,compilerSha256:env.ORESLANG_LLVM_COMPILER_SHA256};
}
async function corpus(){
  const bytes=await readFile(manifestUrl);
  const actualBlob=createHash("sha1").update(Buffer.from("blob "+bytes.length+"\0","ascii"))
    .update(bytes).digest("hex");
  assert.equal(actualBlob,reviewedBlobSha,"shared corpus Git blob changed without reviewed pin");
  const data=JSON.parse(bytes.toString("utf8"));
  assert.equal(data.schema_version,"2026-11-01.scalar-v2");
  assert.equal(data.scope,"import-free-pure-i64");
  assert.equal(data.positive.length,10);
  assert.equal(data.negative.length,4);
  const ids=new Set();
  for(const item of [...data.positive,...data.negative]){
    assert.match(item.id,/^[a-z][a-z0-9-]{1,79}$/);
    assert.equal(ids.has(item.id),false,"duplicate corpus ID");
    ids.add(item.id);
    assert.match(item.expression,/^[0-9_()+*%^\/ -]{1,128}$/,"unreviewed source grammar");
  }
  for(const item of data.positive){
    assert.match(item.expression,/^[0-9_()+* -]{1,128}$/,"positive case has forbidden operator");
    assert.match(item.expected,/^-?(?:0|[1-9][0-9]*)$/);
    const value=BigInt(item.expected);
    assert.ok(value>=-(1n<<63n)&&value<1n<<63n);
  }
  return data;
}

test("portable source corpus is pinned and contains 10 positive and 4 negative controls",async()=>{
  await corpus(); // This is only a host-side source contract, not native execution.
});
test("required parity refuses missing compiler identity rather than counting skipped tests",()=>{
  assert.throws(()=>admitCompiler({}),/requires a real absolute/);
  assert.throws(()=>admitCompiler({ORESLANG_LLVM_COMPILER:"/not-verified"}),/requires pinned/);
  assert.throws(()=>admitCompiler({
    ORESLANG_LLVM_COMPILER:"/not-verified",
    ORESLANG_LLVM_COMPILER_SHA256:"a".repeat(64)
  }),/independently reviewed/);
});

test("real compiler to bounded Wasm guest executes portable scalar source and rejects negatives",{
  skip:!process.env.ORESLANG_LLVM_COMPILER && !required,
  timeout:480000
},async()=>{
  const {compiler,compilerSha256}=admitCompiler(process.env);
  const compilerSnapshot=await readBoundedRegularFile(compiler,256*1024*1024,
    "missing, invalid or oversized native LLVM compiler");
  assert.equal(sha256(compilerSnapshot.bytes),compilerSha256,
    "compiler executable differs from explicitly pinned SHA256");
  const data=await corpus();
  const dir=await mkdtemp(join(tmpdir(),"oreslang-portable-scalar-"));
  let completed=0;
  try {
    for(const item of data.positive){
      const source=join(dir,item.id+".ores");
      const output=join(dir,item.id+".wasm");
      const bytes=Buffer.from(sourceFor(item.expression),"utf8");
      await writeFile(source,bytes,{flag:"wx",mode:0o400});
      const built=await compileOresToWasm({
        compiler,compilerSha256,source,output,environment:"browser",publication:"atomic"
      });
      const released=await readAtomicRelease(output);
      assert.equal(built.sourceSha256,sha256(bytes),item.id+" source provenance");
      assert.equal(built.compilerSha256,compilerSha256,item.id+" compiler provenance");
      assert.equal(built.wasmSha256,sha256(released.wasm),item.id+" physical Wasm digest");
      assert.equal(released.manifest.wasmSha256,built.wasmSha256);
      assert.deepEqual(released.manifest.imports,[],item.id+" must have zero imports");
      assert.deepEqual(released.manifest.requiredCapabilities,[],item.id+" needs no host grants");
      const observed=await runIsolatedCoreGuest(released.wasm,{
        expectedSha256:built.wasmSha256,timeoutMs:5000
      });
      assert.equal(observed.value,BigInt(item.expected),item.id+" executed value");
      assert.equal(observed.admission.hostCapabilities,0,item.id+" host grants");
      assert.equal(observed.admission.imports,0,item.id+" imported functions");
      completed++;
    }
    for(const item of data.negative){
      const source=join(dir,item.id+".ores");
      const output=join(dir,item.id+".wasm");
      await writeFile(source,sourceFor(item.expression),{flag:"wx",mode:0o400});
      // The bridge now rejects removed percent before invoking the compiler.
      // Prove both independent denials; a bridge error alone never qualifies.
      if (item.id === "removed-percent") {
        await assertNativeRemovedPercent({compiler,compilerSha256,source,work:dir});
        await assert.rejects(
          compileOresToWasm({compiler,compilerSha256,source,output,
            environment:"browser",publication:"atomic"}),
          e=>/^ATTO_REMOVED_OPERATOR: '%' is not an AttoLang source operator at offset [0-9]+$/.test(e.message),
          item.id+" must also be rejected by the bridge");
      } else {
        await assert.rejects(
          compileOresToWasm({
            compiler,compilerSha256,source,output,environment:"browser",publication:"atomic"
          }),
          error=>/oreslang-llvmc:/.test(String(error?.message||"")),
          item.id+" must be rejected by the actual language compiler, not a bridge error"
        );
      }
      await assert.rejects(stat(output),{code:"ENOENT"},
        item.id+" rejection must not publish standalone Wasm");
      await assert.rejects(stat(output+".current.json"),{code:"ENOENT"},
        item.id+" rejection must not publish a release pointer");
      completed++;
    }
    assert.equal(completed,14,"a partial matrix cannot be a green parity result");
  }finally{
    await cleanupRealCompilerWorkspace(dir);
  }
});
