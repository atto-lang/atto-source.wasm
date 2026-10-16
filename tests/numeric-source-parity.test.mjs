import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp,readFile,writeFile,rm,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {compileOresToWasm,readBoundedRegularFile} from "../scripts/compile-ores.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";

// This suite is intentionally NOT counted as parity unless the *real* native
// LLVM compiler is supplied, pinned and used to execute actual wasm32 output.
test("shared source-i64 numeric controls execute in real compiler -> wasm32 guest", {
  skip: !process.env.ORESLANG_LLVM_COMPILER,
  timeout: 180000
}, async () => {
  const compiler = process.env.ORESLANG_LLVM_COMPILER;
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
      const compiled=await compileOresToWasm({
        compiler,compilerSha256:expectedCompilerSha,source:input,output:target
      });
      const code=await readFile(target);
      const observed=await runIsolatedCoreGuest(code,{
        expectedSha256:compiled.wasmSha256,timeoutMs:5000
      });
      assert.equal(observed.value,expected,"numeric source-i64 "+expression);
      assert.equal(observed.admission.hostCapabilities,0);
    }
    for (let i=0;i<3;i++) {
      const source=["pub fnc main():int{return 1.25;}",
                    "pub fnc main():bigint{return 1;}",
                    "pub fnc main():decimal{return 1;}"][i];
      const target=join(dir,"invalid-"+i+".wasm");
      await writeFile(input,source);
      await assert.rejects(
        compileOresToWasm({
          compiler,compilerSha256:expectedCompilerSha,source:input,output:target
        }),
        error=>/oreslang-llvmc:/.test(error.message),
        "unsupported precision must be rejected by the real frontend"
      );
      await assert.rejects(stat(target),{code:"ENOENT"});
    }
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
});
