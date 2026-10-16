import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {compileOresToWasm} from "../scripts/compile-ores.mjs";

// Wasm delegates Oreslang parsing to the actual pinned native LLVM compiler.
// Do not claim support based on a mock compiler, host-side JS or hand-made IR.
const compiler = process.env.ORESLANG_LLVM_COMPILER;
test("structural forms fail closed through real LLVM -> Wasm bridge", {
  skip: !compiler && "requires ORESLANG_LLVM_COMPILER pointing to a real compiler"
}, async () => {
  const dir = await mkdtemp(join(tmpdir(),"ores-wasm-structural-"));
  try {
    const cases = [
      ["callable", "structural fnc main(): int { return 1; }",
        /native structural callable requires/],
      ["parameter", "fnc check(structural Shape s): int { return 1; }\nfnc main(): int { return 1; }",
        /native structural parameter requires/],
      ["value-match", "fnc main(): int { return match 1 over on _ -> { return 1; } end; }",
        /native structural match expression requires/]
    ];
    for (const [name,source,diagnostic] of cases) {
      const input = join(dir,name+".ores");
      const output = join(dir,name+".wasm");
      await writeFile(input,source);
      await assert.rejects(
        compileOresToWasm({compiler:resolve(compiler),source:input,output}),
        diagnostic, "unsupported "+name+" must not emit Wasm");
      await assert.rejects(stat(output),{code:"ENOENT"});
    }
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
});
