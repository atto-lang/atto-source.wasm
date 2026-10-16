import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp,readFile,writeFile,rm,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {compileOresToWasm,readBoundedRegularFile} from "../scripts/compile-ores.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";
import {readAtomicRelease} from "../scripts/atomic-release.mjs";

// This suite is intentionally NOT counted as parity unless the *real* native
// LLVM compiler is supplied, pinned and used to execute actual wasm32 output.
test("shared source-i64 numeric controls execute in real compiler -> wasm32 guest", {
  // A regular developer run may skip an unavailable external compiler.
  // A dedicated parity job must fail closed instead of counting a skip.
  skip: !process.env.ORESLANG_LLVM_COMPILER
    && process.env.ORESLANG_NUMERIC_PARITY_REQUIRED !== "1",
  timeout: 180000
}, async () => {
  const compiler = process.env.ORESLANG_LLVM_COMPILER;
  assert.ok(compiler,
    "numeric parity required: pinned real Oreslang LLVM compiler is missing");
  const expectedCompilerSha = process.env.ORESLANG_LLVM_COMPILER_SHA256;
  const declaredLlvmSourceSha = process.env.ORESLANG_LLVM_SOURCE_SHA;
  assert.match(expectedCompilerSha || "", /^[a-f0-9]{64}$/,
    "real numeric conformance requires pinned compiler SHA-256");
  assert.match(declaredLlvmSourceSha || "", /^[a-f0-9]{40}$/,
    "real numeric conformance requires independently reviewed LLVM source SHA");
  // Snapshot the compiler through the same no-follow, regular-file and
  // 256 MiB admission boundary as the production Wasm bridge.
  const compilerSnapshot = await readBoundedRegularFile(
    compiler,256*1024*1024,"invalid or oversized native compiler");
  const actualCompilerSha = createHash("sha256").update(compilerSnapshot.bytes).digest("hex");
  assert.equal(actualCompilerSha, expectedCompilerSha);
  const fixtureBytes = await readFile(new URL(
    "../contracts/v1/numeric-parity/source-i64-cases.json",import.meta.url));
  const gitBlobHeader = Buffer.from("blob " + fixtureBytes.length + "\0","ascii");
  const fixtureHash = createHash("sha1").update(gitBlobHeader)
    .update(fixtureBytes).digest("hex");
  assert.equal(fixtureHash,"bbc319c19ecd007109d33592e210091eb267e5a2",
    "numeric guest fixture SHA differs from reviewed source corpus");
  const corpus = JSON.parse(fixtureBytes.toString("utf8"));
  assert.equal(corpus.schema_version,"1.0.0");
  assert.equal(corpus.status,"reference-only-not-compiled-execution");
  assert.equal(corpus.cases.length,7);
  const controls = corpus.cases.map(c=>[c.expression,BigInt(c.expected)]);
  const dir = await mkdtemp(join(tmpdir(),"ores-numeric-parity-"));
  try {
    const input = join(dir,"source.ores");
    for (let i=0;i<controls.length;i++) {
      const [expression,expected]=controls[i], target=join(dir,"guest-"+i+".wasm");
      await writeFile(input,"pub fnc main():int{return "+expression+";}\n");
      const sourceHash = createHash("sha256").update(await readFile(input)).digest("hex");
      const compiled=await compileOresToWasm({
        compiler,compilerSha256:expectedCompilerSha,source:input,output:target,
        environment:"browser",publication:"atomic"
      });
      const released=await readAtomicRelease(target);
      assert.equal(compiled.compilerSha256,expectedCompilerSha);
      assert.equal(compiled.sourceSha256,sourceHash);
      assert.equal(compiled.wasmSha256,released.manifest.wasmSha256);
      assert.equal(released.manifest.environment,"browser");
      assert.deepEqual(released.manifest.imports,[]);
      assert.deepEqual(released.manifest.requiredCapabilities,[]);
      const observed=await runIsolatedCoreGuest(released.wasm,{
        expectedSha256:compiled.wasmSha256,timeoutMs:5000
      });
      assert.equal(observed.value,expected,"numeric source-i64 "+expression);
      assert.equal(observed.admission.hostCapabilities,0);
    }
    const negatives=[
      "pub fnc main():int{return 3/2;}",
      "pub fnc main():int{return 1.25;}",
      "pub fnc main():bigint{return 1;}",
      "pub fnc main():decimal{return 1;}",
      // Compile-time integer overflow must not wrap into a valid wasm i64.
      "pub fnc main():int{return 9223372036854775808;}",
      "pub fnc main():int{return 9223372036854775807+1;}",
      "pub fnc main():int{return -9223372036854775808-1;}",
      "pub fnc main():int{return 3037000500*3037000500;}",
      "pub fnc main():int{return -(-9223372036854775808);}"
    ];
    for (let i=0;i<negatives.length;i++) {
      const source=negatives[i];
      const target=join(dir,"invalid-"+i+".wasm");
      await writeFile(input,source);
      await assert.rejects(
        compileOresToWasm({
          compiler,compilerSha256:expectedCompilerSha,source:input,output:target,
          environment:"browser",publication:"atomic"
        }),
        error=>/oreslang-llvmc:/.test(error.message),
        "unsupported precision must be rejected by the real frontend"
      );
      await assert.rejects(stat(target + ".current.json"),{code:"ENOENT"},
        "failed numeric compilation must not publish a release pointer");
    }
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
});
