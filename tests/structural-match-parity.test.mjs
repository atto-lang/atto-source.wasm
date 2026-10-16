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
      ["routine-callable", "structural routine main(): int { return 1; }",
        /native structural callable requires/],
      ["parameter", "fnc check(structural Shape s): int { return 1; }\nfnc main(): int { return 1; }",
        /native structural parameter requires/],
      ["routine-parameter", "routine check(structural Shape s): int { return 1; }\nfnc main(): int { return 1; }",
        /native structural parameter requires/],
      ["statement-match", "fnc main(): int { match 1 over on _ -> { return 1; } end return 1; }",
        /native structural match expression requires/],
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


test("missing LLVM compiler cannot publish a success-shaped structural artifact", {
  skip: !!compiler && "configured compiler is covered by the real bridge test"
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ores-wasm-structural-absent-"));
  try {
    const input = join(dir, "structural.ores");
    const output = join(dir, "structural.wasm");
    await writeFile(input, "structural fnc main(): int { return 1; }");
    await assert.rejects(
      compileOresToWasm({compiler:join(dir,"missing-oreslang-llvmc"),
                         source:input,output}),
      /ENOENT|no such file/i);
    for (const artifact of [output, output+".provenance.json",
                            output+".artifact.json",output+".current.json"]) {
      await assert.rejects(stat(artifact), {code:"ENOENT"});
    }
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
});
