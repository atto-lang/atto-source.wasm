import {cleanupRealCompilerWorkspace} from '../scripts/cleanup-real-compiler.mjs';
// Shared native Oreslang zero-assertions: WASM core execution lane.
// This is NOT the hosted ores.std/testing TestSuite. Real LLVM compiler is
// required for execution; a static inventory check cannot count guest passes.
import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile, writeFile, mkdtemp, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, isAbsolute} from "node:path";
import {fileURLToPath} from "node:url";
import {compileOresToWasm, readBoundedRegularFile} from "../scripts/compile-ores.mjs";
import {readAtomicRelease} from "../scripts/atomic-release.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";

const sourceRoot=fileURLToPath(new URL("../contracts/parity/native-scalar-zero-v1/",import.meta.url));
const expected=new Map([
  ["precedence-zero.ores","pub fnc main():int{return (2 + 3 * 4) - 14;}\n"],
  ["i64-precision-zero.ores","pub fnc main():int{return (9007199254740993 - 9007199254740992) - 1;}\n"],
  ["signed-opposite-zero.ores","pub fnc main():int{return (9007199254740993 + (-9007199254740992)) - 1;}\n"],
  ["nested-subtraction-zero.ores","pub fnc main():int{return (100 - (50 - (20 - 7))) - 63;}\n"],
  ["min-boundary-zero.ores","pub fnc main():int{return (-9223372036854775808 + 1) - (-9223372036854775807);}\n"],
  ["reject-removed-operator.ores","pub fnc main():int{return 7 % 3;}\n"]
]);
const sha256=bytes=>createHash("sha256").update(bytes).digest("hex");
const required=process.env.ORESLANG_SCALAR_PARITY_REQUIRED==="1";

async function pinnedSources(){
  for(const [name,text] of expected){
    const actual=await readFile(join(sourceRoot,name));
    assert.deepEqual(actual,Buffer.from(text,"utf8"),name+" source drift");
  }
}
async function compilerIdentity(){
  const compiler=process.env.ORESLANG_LLVM_COMPILER;
  const digest=process.env.ORESLANG_LLVM_COMPILER_SHA256;
  const sourceSha=process.env.ORESLANG_LLVM_SOURCE_SHA;
  assert.ok(compiler&&isAbsolute(compiler),"expected absolute native LLVM compiler");
  assert.match(digest||"",/^[0-9a-f]{64}$/,"missing pinned compiler SHA256");
  assert.match(sourceSha||"",/^[0-9a-f]{40}$/,"missing reviewed LLVM source SHA");
  const executable=await readBoundedRegularFile(compiler,256*1024*1024,
    "compiler must be a bounded regular file");
  assert.equal(sha256(executable.bytes),digest,"LLVM compiler binary mismatch");
  return {compiler,compilerSha256:digest};
}

test("all six cross-toolchain native Oreslang source fixtures match pinned bytes",pinnedSources);

test("actual LLVM-to-WASM guest executes five zero assertions and rejects a removed operator",{
  skip:!process.env.ORESLANG_LLVM_COMPILER&&!required,
  timeout:360000
},async()=>{
  await pinnedSources();
  const {compiler,compilerSha256}=await compilerIdentity();
  const dir=await mkdtemp(join(tmpdir(),"oreslang-scalar-zero-"));
  try{
    let completed=0;
    for(const [name,text] of expected){
      const source=join(dir,name);
      const output=join(dir,name+".wasm");
      const bytes=Buffer.from(text,"utf8");
      await writeFile(source,bytes,{flag:"wx",mode:0o400});
      if(name==="reject-removed-operator.ores"){
        await assert.rejects(
          compileOresToWasm({compiler,compilerSha256,source,output,
            environment:"browser",publication:"atomic"}),
          e=>/oreslang-llvmc:/.test(String(e?.message||"")),
          "removed % must be rejected by native compiler"
        );
        await assert.rejects(stat(output+".current.json"),{code:"ENOENT"});
      }else{
        const built=await compileOresToWasm({compiler,compilerSha256,source,output,
          environment:"browser",publication:"atomic"});
        const release=await readAtomicRelease(output);
        assert.equal(built.sourceSha256,sha256(bytes),name+" source provenance");
        assert.equal(built.compilerSha256,compilerSha256);
        assert.equal(built.wasmSha256,sha256(release.wasm));
        assert.deepEqual(release.manifest.imports,[]);
        assert.deepEqual(release.manifest.requiredCapabilities,[]);
        const observed=await runIsolatedCoreGuest(release.wasm,{
          expectedSha256:built.wasmSha256,timeoutMs:5000
        });
        assert.equal(observed.value,0n,name+" native Oreslang test FAILED");
        assert.equal(observed.admission.imports,0);
        assert.equal(observed.admission.hostCapabilities,0);
      }
      completed++;
    }
    // Valid Oreslang with a deliberately wrong expected value must not pass.
    const mutantSource=join(dir,"wrong-expected.ores");
    const mutantOutput=join(dir,"wrong-expected.wasm");
    const mutantText="pub fnc main():int{return (2 + 3 * 4) - 13;}\n";
    await writeFile(mutantSource,mutantText,{flag:"wx",mode:0o400});
    const mutantBuild=await compileOresToWasm({compiler,compilerSha256,
      source:mutantSource,output:mutantOutput,environment:"browser",publication:"atomic"});
    const mutantRelease=await readAtomicRelease(mutantOutput);
    assert.equal(mutantBuild.wasmSha256,sha256(mutantRelease.wasm));
    const mutantObserved=await runIsolatedCoreGuest(mutantRelease.wasm,{
      expectedSha256:mutantBuild.wasmSha256,timeoutMs:5000
    });
    assert.equal(mutantObserved.value,1n,"mutant must execute with nonzero result");
    assert.notEqual(mutantObserved.value,0n,"wrong Oreslang assertion cannot be green");
    assert.equal(completed,6,"all five guests and negative control must run");
  }finally{await cleanupRealCompilerWorkspace(dir);}
});
