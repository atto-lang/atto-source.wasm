import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp,readFile,writeFile,rm,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {compileOresToWasm} from "../scripts/compile-ores.mjs";
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
  const actualCompilerSha = createHash("sha256").update(await readFile(compiler)).digest("hex");
  assert.equal(actualCompilerSha, expectedCompilerSha);
  const controls = [
    ["2+3*4",14n],["(2+3)*4",20n],["(8-3)*5+2",27n],
    ["100-(3+2)-19",76n],["3*4-2*5-7",-5n],
    ["9223372036854775807-1",9223372036854775806n],
    ["-9223372036854775808",-9223372036854775808n]
  ];
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
