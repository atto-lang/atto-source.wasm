import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {assertNativeFrontendRejection} from "../scripts/verify-real-compiler.mjs";
import {readBoundedRegularFile} from "../scripts/compile-ores.mjs";

// This is a negative admission gate, NOT proof of positive language parity.
// Wasm sources compile through the pinned native LLVM compiler; the Wasm
// host must never synthesize success when the real compiler cannot lower them.
const hasCompiler = Boolean(process.env.ORESLANG_LLVM_COMPILER);

// The compiler is a separate native process. Never inherit CI credentials,
// Node injection hooks, GitHub tokens, cloud credentials or loader overrides.
function compilerEnvironment(tmpdir) {
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TMPDIR: tmpdir
  };
}

test("method/capture parity gate requires independently pinned LLVM compiler", {
  skip: !hasCompiler && process.env.ORESLANG_METHOD_PARITY_REQUIRED !== "1"
}, async () => {
  const path = process.env.ORESLANG_LLVM_COMPILER;
  assert.match(path || "", /^\//, "real compiler absolute path required");
  assert.match(process.env.ORESLANG_LLVM_COMPILER_SHA256 || "", /^[a-f0-9]{64}$/,
    "real compiler artifact hash required");
  assert.match(process.env.ORESLANG_LLVM_SOURCE_SHA || "", /^[a-f0-9]{40}$/,
    "reviewed LLVM source commit required");
  // Bound the snapshot before reading: a regular-file path alone does not
  // prevent a large or special-file OOM/hang in the validation runner.
  const bytes = (await readBoundedRegularFile(path, 256 * 1024 * 1024,
    "real compiler must be a regular file <= 256 MiB")).bytes;
  assert.ok(bytes.length > 0 && bytes.length <= 256 * 1024 * 1024,
    "real compiler must be a bounded executable file");
  assert.equal(createHash("sha256").update(bytes).digest("hex"),
    process.env.ORESLANG_LLVM_COMPILER_SHA256,
    "compiler binary must match the exact pinned digest");

  const sources = [
    "fnc main():int {val int x=1; val f=lex[x] || -> x; return 1;}",
    "fnc main():int {val int x=1; val f=nlex[x] || -> x; return 1;}",
    "fnc main():int {val int x=1; val f=lex[self] || -> 1; return 1;}",
    "fnc main():int {val int x=1; val f=nlex[self] critical |state| -> {state.count=1;};return 1;}",
    "fnc main():int {val int x=1; val f=lex[x,x] || -> x; return 1;}",
    "fnc main():int {val int x=1; val f=lex[missing] || -> x; return 1;}",
    "fnc main():int {val int x=1; val f=lex[] || -> x; return 1;}",
    "fnc main():int {val int x=1; val f=nlex[] || -> x; return 1;}",
    "fnc main():int {val int x=1; val f=nlex[self] || -> x; return 1;}",
    "fnc main():int {val int x=1; val f=lex[x] |x| -> x; return 1;}",
    "fnc main():int {val int x=1; val f=|y| -> x; return 1;}",
    "fnc main():int {val int x=1; val f=lex[x] || -> nlex || -> x; return 1;}",
    "define class Foo as fnc read(mut self, int x): int {return x;} end fnc main():int{return 1;}",
    // Receiver-aware class method lowering is tested separately by actual
    // wasm32 guest execution. Do not treat generic failure as proof of arity.
    "define actor Foo as receive(self, int x): void {return;} end fnc main():int{return 1;}",
    "define actor Foo as on_start(self): void {return;} end fnc main():int{return 1;}",
    "define actor Foo as receive(ActorMail<int> mail): void {self.receive(mail);return;} end fnc main():int{return 1;}",
    "define abstract class Framework as private abstract receive(int x): int; end fnc main():int{return 1;}",
    "define class Worker as private abstract receive(int x): int; end fnc main():int{return 1;}"
  ];
  const dir = mkdtempSync(join(tmpdir(),"ores-method-capture-wasm-"));
  try {
    // Execute the immutable, locally snapshotted bytes, not a potentially
    // replaced path after the SHA-256 check (avoid check/use races).
    const pinned = join(dir,"pinned-oreslang-llvmc");
    writeFileSync(pinned,bytes,{flag:"wx",mode:0o500});
    for (let i = 0; i < sources.length; i++) {
      const input = join(dir, `unsupported-${i}.ores`);
      writeFileSync(input, sources[i], {mode:0o600});
      const result = spawnSync(pinned,["--target=wasm32", input],{
        encoding:"utf8",timeout:30000,maxBuffer:1024*1024,
        env:compilerEnvironment(dir)
      });
      assert.equal(assertNativeFrontendRejection(result),true,
        `unsupported source was not rejected: ${i}`);
      // A compiler must remain byte-identical after every negative case.
      // The next case must never execute a mutated/replaced binary.
      assert.equal(createHash("sha256").update((await readBoundedRegularFile(pinned,
        256 * 1024 * 1024, "pinned compiler grew beyond its budget")).bytes).digest("hex"),
        process.env.ORESLANG_LLVM_COMPILER_SHA256,
        `pinned compiler mutated during rejection probe ${i}`);
    }
  } finally {
    rmSync(dir,{recursive:true,force:true});
  }
});

test("no independent JavaScript parser claims scoped capture semantics", () => {
  assert.equal(hasCompiler || process.env.ORESLANG_METHOD_PARITY_REQUIRED !== "1",true,
    "required real compiler unavailable; do not substitute a fake compiler");
});

test("compiler admission rejects a symlink and oversized sparse file before reading", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ores-compiler-snapshot-safety-"));
  try {
    const real = join(dir, "compiler");
    const link = join(dir, "compiler-link");
    const huge = join(dir, "oversized-sparse-compiler");
    writeFileSync(real, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    symlinkSync(real, link);
    await assert.rejects(
      readBoundedRegularFile(link, 256 * 1024 * 1024, "compiler exceeds maximum"),
      /symlink or special input file is forbidden/
    );
    writeFileSync(huge, "");
    truncateSync(huge, 256 * 1024 * 1024 + 1);
    await assert.rejects(
      readBoundedRegularFile(huge, 256 * 1024 * 1024, "compiler exceeds maximum"),
      /compiler exceeds maximum/
    );
  } finally {
    rmSync(dir, {recursive:true,force:true});
  }
});

test("LLVM frontend subprocess environment excludes CI credentials and loader hooks", () => {
  const keys = Object.keys(compilerEnvironment("/tmp/ores-test"));
  assert.deepEqual(keys.sort(), ["LANG","LC_ALL","PATH","TMPDIR"].sort());
  for (const sensitive of ["GITHUB_TOKEN","GH_TOKEN","AWS_SECRET_ACCESS_KEY",
    "AZURE_CLIENT_SECRET","GOOGLE_APPLICATION_CREDENTIALS",
    "NODE_OPTIONS","LD_PRELOAD","DYLD_INSERT_LIBRARIES","HOME"]) {
    assert.equal(Object.hasOwn(compilerEnvironment("/tmp/ores-test"),sensitive), false);
  }
});
