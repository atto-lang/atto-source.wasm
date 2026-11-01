// Required native StateGraph conformance. Never skip for absent toolchains.
// This is host *test infrastructure*, not a StateGraph implementation.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdtemp,writeFile,readFile,stat,rm} from "node:fs/promises";
import {join,isAbsolute,resolve} from "node:path";
import {tmpdir} from "node:os";
import {compileOresToWasm,readBoundedRegularFile} from "../scripts/compile-ores.mjs";

const compiler=process.env.ORESLANG_LLVM_COMPILER;
const compilerSha=process.env.ORESLANG_LLVM_COMPILER_SHA256;
const sourceSha=process.env.ORESLANG_LLVM_SOURCE_SHA;
const root=resolve(import.meta.dirname,"..");
const fixedSource="fnc main():int{return 6*7;}\n";
const sha256=x=>createHash("sha256").update(x).digest("hex");

if(!compiler || !isAbsolute(compiler))
  throw Error("SG_WASM_NOT_ACCEPTED: absolute trusted compiler is required");
if(!/^[a-f0-9]{64}$/.test(compilerSha||""))
  throw Error("SG_WASM_NOT_ACCEPTED: compiler SHA-256 pin required");
if(!/^[a-f0-9]{40}$/.test(sourceSha||""))
  throw Error("SG_WASM_NOT_ACCEPTED: Oreslang LLVM source commit required");

const bytes=(await readBoundedRegularFile(compiler,256*1024*1024)).bytes;
assert.equal(sha256(bytes),compilerSha,"SG_WASM_NOT_ACCEPTED: compiler digest mismatch");
const source=join(root,"contracts/stategraph-portability/shared-scalar.ores");
assert.equal((await readFile(source)).toString("utf8"),fixedSource);
const work=await mkdtemp(join(tmpdir(),"stategraph-required-wasm-"));
try {
  const pinned=join(work,"pinned-oreslang-llvmc");
  await writeFile(pinned,bytes,{flag:"wx",mode:0o500});
  const output=join(work,"scalar.wasm");
  const built=await compileOresToWasm({
    compiler:pinned,compilerSha256:compilerSha,source,output,
    environment:"browser",publication:"atomic"
  });
  assert.equal(built.compilerSha256,compilerSha);
  assert.equal(built.sourceSha256,sha256(Buffer.from(fixedSource)));
  // Atomic releases are not necessarily ordinary files at output;
  // the existing native verifier checks artifact integrity and guest execution.
  const {readAtomicRelease}=await import("../scripts/atomic-release.mjs");
  const {runIsolatedCoreGuest}=await import("../src/isolated-runner.mjs");
  const release=await readAtomicRelease(output);
  assert.equal(built.wasmSha256,sha256(release.wasm));
  const actual=await runIsolatedCoreGuest(release.wasm,{
    expectedSha256:built.wasmSha256,timeoutMs:5000
  });
  assert.equal(actual.value,42n,"SG_WASM_NOT_ACCEPTED: incorrect native guest result");
  assert.equal(actual.admission.hostCapabilities,0);

  // Reject missing language support only through compiler-owned diagnostics.
  // A missing clang/toolchain/bridge MUST NOT count as a negative-language pass.
  for(const name of ["generic-state","actor-owned"]){
    const negative=join(root,"examples/stategraph-portability",name+".ores");
    assert.equal((await stat(negative)).isFile(),true);
    const result=spawnSync(pinned,["--target=wasm32",negative],{
      encoding:"utf8",timeout:30000,maxBuffer:65536
    });
    assert.equal(result.error,undefined,"compiler launch error is not a source rejection");
    assert.equal(result.signal,null,"compiler timeout is not a source rejection");
    assert.equal(result.status,1,"unsupported Oreslang source must return compiler rejection");
    assert.equal(result.stdout,"","rejected source may not emit IR");
    assert.match(result.stderr,/^oreslang-llvmc:\s+\S/m,
      "unsupported source needs compiler-owned diagnostic");
    console.log("SG_WASM_FEATURE_REJECTED",name);
  }
  console.log("SG_WASM_REQUIRED_NATIVE_PASS",
    JSON.stringify({compilerSha256:compilerSha,llvmSourceSha:sourceSha,
      canonicalSourceSha256:built.sourceSha256,guestResult:"42",negativeCases:2}));
} finally {
  const {cleanupRealCompilerWorkspace}=await import("../scripts/cleanup-real-compiler.mjs");
  await cleanupRealCompilerWorkspace(work);
}
