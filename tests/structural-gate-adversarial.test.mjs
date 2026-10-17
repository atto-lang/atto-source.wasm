import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync, writeFileSync, chmodSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

// Source-free checks for the real structural admission test harness.
// They are not LLVM backend or wasm32 guest-language execution evidence.
const target = fileURLToPath(new URL("./structural-source-contract.test.mjs", import.meta.url));
const mock = `#!/usr/bin/env node
const {readFileSync, writeFileSync} = require("node:fs");
const {basename} = require("node:path");
const mode = basename(process.argv[1]);
const source = readFileSync(process.argv[2], "utf8");
const scalar = source.includes("pub fnc main(): int { return 42; }");
if (mode === "always-reject") {
  console.error("unsupported");
  process.exit(1);
}
if (mode === "always-accept") {
  console.log("define i64 @__oreslang_guest_main(");
  process.exit(0);
}
if (scalar) {
  console.log("define i64 @__oreslang_guest_main(");
  process.exit(0);
}
if (mode === "artifact") writeFileSync("partial.ll", "bad");
if (mode === "stdout-leak") console.log("partial IR");
if (mode !== "missing-diagnostic") console.error("oreslang-llvmc: unsupported");
process.exit(1);
`;

test("required WASM structural admission gate denies false-green compilers", () => {
  const dir = mkdtempSync(join(tmpdir(), "ores-wasm-adversarial-"));
  try {
    for (const mode of ["missing-compiler", "correct", "always-reject",
                        "always-accept", "artifact", "stdout-leak",
                        "missing-diagnostic"]) {
      const compiler = join(dir, mode);
      if (mode !== "missing-compiler") {
        writeFileSync(compiler, mock, {mode: 0o700});
        chmodSync(compiler, 0o700);
      }
      const env = {...process.env, ORESLANG_REQUIRE_STRUCTURAL_COMPILER:"1"};
      delete env.NODE_TEST_CONTEXT; // nested node --test must start as a fresh coordinator
      if (mode === "missing-compiler") delete env.ORESLANG_LLVM_COMPILER;
      else env.ORESLANG_LLVM_COMPILER = compiler;
      const result = spawnSync(process.execPath, ["--test", target], {
        env, encoding:"utf8", timeout:45000, maxBuffer:2*1024*1024
      });
      assert.equal(result.error, undefined, mode + ": test process started");
      assert.equal(result.status === 0, mode === "correct",
        mode + ": unexpected status " + result.status + "\n" + result.stdout.slice(-800));
    }
  } finally {
    rmSync(dir, {recursive:true, force:true});
  }
});
