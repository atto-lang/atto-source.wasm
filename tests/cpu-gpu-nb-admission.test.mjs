import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, writeFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";

// Wasm has no independently implemented source frontend. Validate the REAL
// LLVM frontend only when it is supplied; never pass via a pretend compiler.
const compiler = process.env.ORESLANG_LLVM_COMPILER;
test("CPU/GPU/nb nested regions fail closed before Wasm compilation", {
  skip: !compiler && "requires the pinned real oreslang-llvmc"
}, () => {
  const dir = mkdtempSync(join(tmpdir(), "ores-wasm-domain-"));
  try {
    const file = join(dir, "main.ores");
    const negatives = [
      "fnc main():int{const x = gpu {}; return 1;}",
      "fnc main():int{const x = cpu {}; return 1;}",
      "fnc main():int{const x = nb gpu {}; return 1;}",
      "fnc main():int{const x = nb cpu {}; return 1;}",
      "fnc main():int{gpu { cpu { gpu {} } }; return 1;}",
      "fnc main():int{nb gpu { nb cpu {} }; return 1;}",
    ];
    for (const source of negatives) {
      writeFileSync(file, source);
      const compiled = spawnSync(compiler, [file], {
        encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024
      });
      assert.equal(compiled.error, undefined, compiled.error?.message);
      assert.equal(compiled.status, 1, source);
      assert.equal(compiled.stdout, "", "invalid source emitted LLVM IR");
      assert.match(compiled.stderr, /\S/, "missing compiler diagnostic");
    }
    writeFileSync(file, "fnc main():int{return 42;} // nb gpu { cpu {} }");
    const positive = spawnSync(compiler, [file], {
      encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024
    });
    assert.equal(positive.status, 0, positive.stderr);
    assert.match(positive.stdout, /^; ModuleID/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
