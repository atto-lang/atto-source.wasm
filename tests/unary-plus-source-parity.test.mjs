import {cleanupRealCompilerWorkspace} from '../scripts/cleanup-real-compiler.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp,readFile,writeFile,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {compileOresToWasm,readBoundedRegularFile} from "../scripts/compile-ores.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";
import {readAtomicRelease} from "../scripts/atomic-release.mjs";

// No stub and no JS-evaluated substitute. This proof consumes a SHA-pinned
// real LLVM backend with the typed unary-plus source implementation.
// It may be skipped in lightweight local runs, but a required job cannot skip.
test("real LLVM source unary plus executes in core wasm32 without type laundering", {
  timeout: 180000,
  skip: !process.env.ORESLANG_LLVM_COMPILER
    && process.env.ORESLANG_UNARY_PARITY_REQUIRED !== "1"
}, async () => {
  const compiler=process.env.ORESLANG_LLVM_COMPILER;
  assert.ok(compiler,"required real native LLVM compiler absent");
  const compilerSha256=process.env.ORESLANG_LLVM_COMPILER_SHA256;
  assert.match(compilerSha256??"",/^[a-f0-9]{64}$/,"must pin exact compiler bytes");
  assert.match(process.env.ORESLANG_LLVM_SOURCE_SHA??"",/^[a-f0-9]{40}$/,
    "must pin separately reviewed LLVM source head");
  const compilerSnapshot=await readBoundedRegularFile(compiler,256*1024*1024,
    "invalid or oversized native compiler");
  assert.equal(createHash("sha256").update(compilerSnapshot.bytes).digest("hex"),
    compilerSha256,"compiler bytes changed under evidence pin");

  const dir=await mkdtemp(join(tmpdir(),"ores-wasm-unary-plus-"));
  const source=join(dir,"main.ores");
  try {
    const positives=[
      ["+42",42n],
      ["++(40+2)",42n],
      ["2*+(20+1)",42n],
      ["-+(0-42)",42n],
      ["+0",0n],
      ["+(4_0+2)",42n],
      ["+(40_0-35_8)",42n]
    ];
    for (let i=0;i<positives.length;i++) {
      const [expression,expected]=positives[i];
      const output=join(dir,"positive-"+i+".wasm");
      await writeFile(source,"pub fnc main():int{return "+expression+";}\n");
      const sourceSha256=createHash("sha256").update(await readFile(source)).digest("hex");
      const published=await compileOresToWasm({
        compiler,compilerSha256,source,output,environment:"browser",publication:"atomic"
      });
      const released=await readAtomicRelease(output);
      assert.equal(published.compilerSha256,compilerSha256);
      assert.equal(published.sourceSha256,sourceSha256);
      assert.equal(released.manifest.wasmSha256,published.wasmSha256);
      assert.deepEqual(released.manifest.imports,[]);
      assert.deepEqual(released.manifest.requiredCapabilities,[]);
      const observed=await runIsolatedCoreGuest(released.wasm,{
        expectedSha256:published.wasmSha256,timeoutMs:5000
      });
      assert.equal(observed.value,expected,"guest unary plus: "+expression);
      assert.equal(observed.admission.hostCapabilities,0);
    }

    // Strict no-IR/no-publication negatives. The host may not interpret
    // +bool or +String as a numeric conversion, even if the source compiler
    // widens its type system in the future.
    const negatives=["+true",'+"x"',"+9223372036854775808","+","1__0","1_"];
    for (let i=0;i<negatives.length;i++) {
      const output=join(dir,"negative-"+i+".wasm");
      await writeFile(source,"pub fnc main():int{return "+negatives[i]+";}\n");
      await assert.rejects(
        compileOresToWasm({
          compiler,compilerSha256,source,output,environment:"browser",publication:"atomic"
        }),
        error => {
          // compile-ores runs a private, byte-pinned snapshot named
          // compiler-exact, NOT the original compiler pathname. A downstream
          // Clang error, missing executable or timeout cannot count as a
          // successful source-language rejection.
          assert.match(error.message,
            /^command failed \([^)]+[\\/]compiler-exact\): oreslang-llvmc: /,
            "rejection must originate in the staged native compiler");
          assert.doesNotMatch(error.message,/spawn |ENOENT|EACCES|ETIMEDOUT|SIGKILL/,
            "infrastructure failure is not a compiler diagnostic");
          return true;
        },
        "unsupported unary plus source must be rejected by the real compiler"
      );
      await assert.rejects(stat(output+".current.json"),{code:"ENOENT"},
        "no release pointer for rejected guest");
      await assert.rejects(stat(output),{code:"ENOENT"},
        "no standalone Wasm artifact for rejected guest");
    }
  } finally { await cleanupRealCompilerWorkspace(dir); }
});
