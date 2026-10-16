import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {assertNativeFrontendRejection} from "../scripts/verify-real-compiler.mjs";

// This is a negative admission gate, NOT proof of positive language parity.
// Wasm sources compile through the pinned native LLVM compiler; the Wasm
// host must never synthesize success when the real compiler cannot lower them.
const hasCompiler = Boolean(process.env.ORESLANG_LLVM_COMPILER);

test("method/capture parity gate requires independently pinned LLVM compiler", {
  skip: !hasCompiler && process.env.ORESLANG_METHOD_PARITY_REQUIRED !== "1"
}, () => {
  const path = process.env.ORESLANG_LLVM_COMPILER;
  assert.match(path || "", /^\//, "real compiler absolute path required");
  assert.match(process.env.ORESLANG_LLVM_COMPILER_SHA256 || "", /^[a-f0-9]{64}$/,
    "real compiler artifact hash required");
  assert.match(process.env.ORESLANG_LLVM_SOURCE_SHA || "", /^[a-f0-9]{40}$/,
    "reviewed LLVM source commit required");
  const bytes = readFileSync(path);
  assert.ok(bytes.length > 0 && bytes.length <= 256 * 1024 * 1024,
    "real compiler must be a bounded executable file");
  assert.equal(createHash("sha256").update(bytes).digest("hex"),
    process.env.ORESLANG_LLVM_COMPILER_SHA256,
    "compiler binary must match the exact pinned digest");

  const sources = [
    "fnc main():int {val int x=1; val f=lex[x] || -> x; return 1;}",
    "fnc main():int {val int x=1; val f=nlex[x] || -> x; return 1;}",
    "fnc main():int {val int x=1; val f=lex[self] || -> 1; return 1;}",
    "fnc main():int {val int x=1; val f=nlex[self] critical |state| -> {state.count=1;};return 1;}"
  ];
  const dir = mkdtempSync(join(tmpdir(),"ores-method-capture-wasm-"));
  try {
    for (let i = 0; i < sources.length; i++) {
      const input = join(dir, `unsupported-${i}.ores`);
      writeFileSync(input, sources[i], {mode:0o600});
      const result = spawnSync(path,["--target=wasm32", input],{
        encoding:"utf8",timeout:30000,maxBuffer:1024*1024
      });
      assert.equal(assertNativeFrontendRejection(result),true,
        `unsupported source was not rejected: ${i}`);
    }
  } finally {
    rmSync(dir,{recursive:true,force:true});
  }
});

test("no independent JavaScript parser claims scoped capture semantics", () => {
  assert.equal(hasCompiler || process.env.ORESLANG_METHOD_PARITY_REQUIRED !== "1",true,
    "required real compiler unavailable; do not substitute a fake compiler");
});
