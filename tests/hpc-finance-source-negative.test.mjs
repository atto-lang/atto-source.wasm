// REAL compiler-negative admission gate for the finance binary64/Region
// unsupported surface. Explicitly not a guest success or finance parity pass.
import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,stat,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {compileOresToWasm} from "../scripts/compile-ores.mjs";

const required=process.env.ORESLANG_HPC_FINANCE_COMPILER_REQUIRED==="1";
const compiler=process.env.ORESLANG_LLVM_COMPILER;
const digest=process.env.ORESLANG_LLVM_COMPILER_SHA256;
const llvmSourceSha=process.env.ORESLANG_LLVM_SOURCE_SHA;
test("Wasm finance native-compiler rejection: unsupported float and Region",{
  skip:!required&&!compiler,
  timeout:120000
},async()=>{
  assert.ok(compiler,"real finance negative-admission requires LLVM compiler");
  assert.match(digest??"",/^[0-9a-f]{64}$/,"pin real compiler binary SHA");
  assert.match(llvmSourceSha??"",/^[0-9a-f]{40}$/,"pin LLVM compiler source SHA");
  const directory=await mkdtemp(join(tmpdir(),"oreslang-finance-wasm-negative-"));
  try {
    const source=join(directory,"finance-negative.ores");
    for(const [index,program] of [
      "pub fnc main():float { return 1.0; }",
      "pub fnc main():int { return 1.25; }",
      "pub compute fnc risk_gate(Region<int> orders):void { return; }",
    ].entries()) {
      const output=join(directory,`rejected-${index}.wasm`);
      await writeFile(source,program+"\n");
      await assert.rejects(
        compileOresToWasm({
          compiler,compilerSha256:digest,source,output,
          environment:"browser",publication:"atomic"
        }),
        error=>/oreslang-llvmc:/.test(String(error?.message??"")),
        "must reject unsupported finance guest at compiler, not at Wasm runtime"
      );
      await assert.rejects(stat(output+".current.json"),{code:"ENOENT"},
        "invalid guest must not publish release pointer");
    }
  }finally{
    await rm(directory,{recursive:true,force:true});
  }
});
