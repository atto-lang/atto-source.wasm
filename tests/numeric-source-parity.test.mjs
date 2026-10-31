import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp,readFile,writeFile,rm,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
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
  assert.equal(declaredLlvmSourceSha,
    "c157ded685419f674657219fa1cbe82a1c447b50",
    "numeric module parity requires the reviewed LLVM leaf-module compiler head");
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
  assert.equal(createHash("sha256").update(fixtureBytes).digest("hex"),"39bddbe558ad1c336271f91e6403c4555f2f16a7ed33a3355ee897721b6ab02a",
    "numeric guest fixture SHA-256 differs from reviewed bytes");
  const corpus = JSON.parse(fixtureBytes.toString("utf8"));
  assert.equal(corpus.schema_version,"1.0.0");
  assert.equal(corpus.status,"reference-only-not-compiled-execution");
  assert.equal(corpus.cases.length,7);
  const controls = corpus.cases.map(c=>[c.expression,BigInt(c.expected)]);
  const overflowBytes = await readFile(new URL(
    "../contracts/v1/numeric-parity/source-i64-overflow-cases.json",import.meta.url));
  const overflowBlobSha = createHash("sha1").update(
    Buffer.from("blob " + overflowBytes.length + "\0","ascii"))
    .update(overflowBytes).digest("hex");
  assert.equal(overflowBlobSha,"2ce0b0ff5c52e54a788280fd64d67fa8dc32614a",
    "negative numeric source corpus must remain byte-identical across backends");
  const overflowCorpus = JSON.parse(overflowBytes.toString("utf8"));
  assert.equal(overflowCorpus.schema_version,"1.0.0");
  assert.equal(overflowCorpus.status,"requires-executable-negative-tests");
  assert.equal(overflowCorpus.policy,"no-wrapping-i64");
  assert.deepEqual(overflowCorpus.cases.map(c=>c.id),[
    "positive-add-overflow","negative-sub-overflow",
    "positive-multiply-overflow","negative-unary-overflow"
  ]);
  const overflowNegatives = overflowCorpus.cases.map(c=>{
    assert.equal(c.expected,"reject-or-runtime-error");
    assert.match(c.source,/^[0-9()+* -]{1,128}$/);
    return "pub fnc main():int{return "+c.source+";}";
  });
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
    const compileRejects=[
      "pub fnc main():int{return 3/2;}",
      "pub fnc main():int{return 1.25;}",
      "pub fnc main():bigint{return 1;}",
      "pub fnc main():decimal{return 1;}",
      // A bare out-of-range literal must always be rejected too.
      "pub fnc main():int{return 9223372036854775808;}"
    ];
    for (let i=0;i<compileRejects.length;i++) {
      const source=compileRejects[i];
      const target=join(dir,"invalid-"+i+".wasm");
      await writeFile(input,source);
      await assert.rejects(
        compileOresToWasm({
          compiler,compilerSha256:expectedCompilerSha,source:input,output:target,
          environment:"browser",publication:"atomic"
        }),
        error=>/oreslang-llvmc:/.test(String(error?.message ?? "")),
        "unsupported numeric source must fail in the real compiler"
      );
      await assert.rejects(stat(target + ".current.json"),{code:"ENOENT"},
        "failed numeric compilation must not publish a release pointer");
    }

    // These are valid i64 programs whose arithmetic result overflows. The
    // current LLVM/Wasm ABI is a checked runtime trap, not wrapping and not
    // yet a typed guest ArithmeticOverflowError.
    for (let i=0;i<overflowNegatives.length;i++) {
      const target=join(dir,"overflow-"+i+".wasm");
      await writeFile(input,overflowNegatives[i]+"\n");
      const compiled=await compileOresToWasm({
        compiler,compilerSha256:expectedCompilerSha,source:input,output:target,
        environment:"browser",publication:"atomic"
      });
      const released=await readAtomicRelease(target);
      await assert.rejects(
        runIsolatedCoreGuest(released.wasm,{
          expectedSha256:compiled.wasmSha256,timeoutMs:5000
        }),
        error=>/guest rejected or failed/.test(String(error?.message ?? "")),
        "checked i64 overflow must fail during isolated Wasm execution"
      );
    }

    const mathPath=fileURLToPath(new URL("../stdlib/math.ores",import.meta.url));
    const mathBytes=await readFile(mathPath);
    const mathBlobSha=createHash("sha1")
      .update(Buffer.from("blob "+mathBytes.length+"\0","ascii"))
      .update(mathBytes).digest("hex");
    assert.equal(mathBlobSha,"725309eb0edae4d32ffbfe159b05fc7d4091bcc1",
      "Wasm canonical Math source differs from the five-backend Git blob");

    const mathEntry=join(dir,"math-entry.ores");
    await writeFile(mathEntry,
      'import module Math from "./math"; pub fnc main():int{return Math.abs(Math.neg(-42));}\n');
    const mathOutput=join(dir,"math.wasm");
    const mathCompiled=await compileOresToWasm({
      compiler,compilerSha256:expectedCompilerSha,source:mathEntry,output:mathOutput,
      sourceDependencies:[{path:mathPath,relativePath:"math.ores"}],
      environment:"browser",publication:"atomic"
    });
    assert.match(mathCompiled.sourceGraphSha256,/^[0-9a-f]{64}$/);
    assert.deepEqual(mathCompiled.sourceDependencies,[{
      relativePath:"math.ores",
      sourceSha256:createHash("sha256").update(mathBytes).digest("hex")
    }]);
    const mathRelease=await readAtomicRelease(mathOutput);
    const mathObserved=await runIsolatedCoreGuest(mathRelease.wasm,{
      expectedSha256:mathCompiled.wasmSha256,timeoutMs:5000
    });
    assert.equal(mathObserved.value,42n,
      "exact canonical stdlib Math must execute as a real wasm32 guest");

    await writeFile(mathEntry,
      'import module Math from "./math"; pub fnc main():int{return Math.neg((-9223372036854775807 - 1));}\n');
    const mathOverflowOutput=join(dir,"math-overflow.wasm");
    const mathOverflow=await compileOresToWasm({
      compiler,compilerSha256:expectedCompilerSha,source:mathEntry,
      output:mathOverflowOutput,
      sourceDependencies:[{path:mathPath,relativePath:"math.ores"}],
      environment:"browser",publication:"atomic"
    });
    const mathOverflowRelease=await readAtomicRelease(mathOverflowOutput);
    await assert.rejects(
      runIsolatedCoreGuest(mathOverflowRelease.wasm,{
        expectedSha256:mathOverflow.wasmSha256,timeoutMs:5000
      }),
      error=>/guest rejected or failed/.test(String(error?.message ?? "")),
      "Math.neg(INT64_MIN) must trap in current Wasm ABI, never wrap"
    );
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
});
