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
import {isSignedI64OverflowDiagnostic} from "../scripts/checked-overflow-ir.mjs";

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
  assert.equal(createHash("sha256").update(fixtureBytes).digest("hex"),"39bddbe558ad1c336271f91e6403c4555f2f16a7ed33a3355ee897721b6ab02a",
    "numeric guest fixture SHA-256 differs from reviewed bytes");
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
    // Overflow negatives come from the *same immutable fixture* as
    // Java, LLVM, .NET and Forge. A data-only oracle is insufficient:
    // reject them using the real pinned LLVM->wasm32 compiler bridge.
    const overflowBytes=await readFile(new URL(
      "../contracts/v1/numeric-parity/source-i64-overflow-cases.json",import.meta.url));
    const overflowBlobHeader=Buffer.from(
      "blob "+overflowBytes.length+"\0","ascii");
    const overflowGitBlob=createHash("sha1").update(overflowBlobHeader)
      .update(overflowBytes).digest("hex");
    assert.equal(overflowGitBlob,"2ce0b0ff5c52e54a788280fd64d67fa8dc32614a",
      "numeric overflow fixture differs from reviewed cross-backend corpus");
    const overflowCorpus=JSON.parse(overflowBytes.toString("utf8"));
    assert.equal(overflowCorpus.schema_version,"1.0.0");
    assert.equal(overflowCorpus.status,"requires-executable-negative-tests");
    assert.equal(overflowCorpus.policy,"no-wrapping-i64");
    assert.equal(overflowCorpus.cases.length,4);
    // Near-boundary companions must return the exact signed-i64 value if
    // the overflow input was lowered to a runtime trap. An unconditional
    // trap (or another fault path unrelated to arithmetic) cannot pass.
    const checkedOperations=Object.freeze({
      "positive-add-overflow":"sadd",
      "negative-sub-overflow":"ssub",
      "positive-multiply-overflow":"smul",
      "negative-unary-overflow":"ssub"
    });
    const safeControls=Object.freeze({
      "positive-add-overflow":["(9223372036854775807-1)+1",(1n<<63n)-1n],
      "negative-sub-overflow":["(-9223372036854775808+1)-1",-(1n<<63n)],
      "positive-multiply-overflow":["3037000499*3037000499",3037000499n*3037000499n],
      "negative-unary-overflow":["-(-9223372036854775808+1)",(1n<<63n)-1n]
    });
    const negativeIds=new Set();
    const overflowNegatives=overflowCorpus.cases.map(entry=>{
      assert.match(entry.id,/^[a-z0-9-]{1,60}$/);
      assert.ok(!negativeIds.has(entry.id),"duplicate numeric overflow fixture ID");
      negativeIds.add(entry.id);
      assert.equal(entry.expected,"reject-or-runtime-error");
      assert.match(entry.source,/^[0-9()+* -]{1,128}$/);
      assert.ok(Object.hasOwn(checkedOperations,entry.id) &&
        Object.hasOwn(safeControls,entry.id),
        "unreviewed overflow fixture cannot be attributed to an arithmetic operation");
      return "pub fnc main():int{return "+entry.source+";}\n";
    });
    const negatives=[
      "pub fnc main():int{return 3/2;}",
      "pub fnc main():int{return 1.25;}",
      "pub fnc main():bigint{return 1;}",
      "pub fnc main():decimal{return 1;}",
      // The bare +2^63 literal remains invalid independently of the
      // four checked arithmetic overflow cases in the shared corpus.
      "pub fnc main():int{return 9223372036854775808;}"
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
    // Unlike unsupported types/syntax, the shared i64 overflow contract
    // explicitly permits *either* compile-time refusal OR a checked trap
    // during real guest execution. Never accept normal wrapped results.
    for (let i=0;i<overflowNegatives.length;i++) {
      const target=join(dir,"overflow-"+i+".wasm");
      await writeFile(input,overflowNegatives[i]);
      let compiled;
      try {
        compiled=await compileOresToWasm({
          compiler,compilerSha256:expectedCompilerSha,source:input,output:target,
          environment:"browser",publication:"atomic",
          checkedOverflowOperation:checkedOperations[overflowCorpus.cases[i].id]
        });
      } catch (error) {
        // Toolchain setup/link failures are NOT arithmetic rejection. Only
        // the real Oreslang frontend's explicit diagnostic is admissible.
        assert.ok(isSignedI64OverflowDiagnostic(error),
          "overflow fixture was rejected for an unrelated compiler reason");
        await assert.rejects(stat(target+".current.json"),{code:"ENOENT"},
          "compile-time overflow refusal must not publish an artifact");
        continue;
      }
      // A compiler that emits a value-producing Wasm guest MUST implement a
      // real checked runtime trap. A wrapped i64 result is a parity failure,
      // as are validation errors, import denials, worker crashes and timeout.
      const released=await readAtomicRelease(target);
      const expectedSourceSha=createHash("sha256")
        .update(Buffer.from(overflowNegatives[i],"utf8")).digest("hex");
      assert.equal(compiled.compilerSha256,expectedCompilerSha,
        "checked-overflow Wasm was not built by the pinned native compiler");
      assert.equal(compiled.sourceSha256,expectedSourceSha,
        "checked-overflow Wasm came from a different source snapshot");
      assert.equal(released.manifest.producer.compilerSha256,expectedCompilerSha);
      assert.equal(released.manifest.producer.sourceSha256,expectedSourceSha);
      assert.equal(released.manifest.wasmSha256,compiled.wasmSha256);
      assert.equal(released.manifest.imports.length,0);
      assert.deepEqual(released.manifest.requiredCapabilities,[]);
      await assert.rejects(
        runIsolatedCoreGuest(released.wasm,{
          expectedSha256:compiled.wasmSha256,timeoutMs:5000
        }),
        error=>error instanceof Error &&
          /^guest rejected or failed: wasm runtime trap: unreachable\b/.test(error.message),
        "overflow source must execute its signed-checked arithmetic guard, not a different fault"
      );
      const [safeExpression,safeValue]=safeControls[overflowCorpus.cases[i].id];
      const safeSource="pub fnc main():int{return "+safeExpression+";}\n";
      const safeTarget=join(dir,"overflow-safe-"+i+".wasm");
      await writeFile(input,safeSource);
      const safeBuilt=await compileOresToWasm({
        compiler,compilerSha256:expectedCompilerSha,source:input,
        output:safeTarget,environment:"browser",publication:"atomic"
      });
      const safeReleased=await readAtomicRelease(safeTarget);
      assert.equal(safeBuilt.compilerSha256,expectedCompilerSha);
      assert.equal(safeReleased.manifest.producer.sourceSha256,
        createHash("sha256").update(Buffer.from(safeSource,"utf8")).digest("hex"));
      const safeResult=await runIsolatedCoreGuest(safeReleased.wasm,{
        expectedSha256:safeBuilt.wasmSha256,timeoutMs:5000
      });
      assert.equal(safeResult.value,safeValue,
        "near-boundary non-overflow source must produce exact i64, not an unconditional trap");
      assert.equal(safeResult.admission.hostCapabilities,0);
    }
  } finally {
    await cleanupRealCompilerWorkspace(dir);
  }
});
