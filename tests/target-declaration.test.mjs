import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,chmod,stat,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {compileOresToWasm} from "../scripts/compile-ores.mjs";
test("LLVM triple in comment cannot satisfy portable guest admission", async () => {
  const dir = await mkdtemp(join(tmpdir(),"ores-wasm-false-triple-"));
  try {
    const source = join(dir,"guest.ores"), compiler = join(dir,"mock-compiler.sh"), output = join(dir,"guest.wasm");
    await writeFile(source,"pub fnc main(): int { return 42; }\n");
    // A test double only: this never counts as native Oreslang compilation.
    const ir = '; target triple = "wasm32-unknown-unknown"\n' +
      'target triple = "x86_64-unknown-linux-gnu"\n' +
      'define i64 @main() { ret i64 42 }\n';
    await writeFile(compiler,"#!/bin/sh\nprintf '%b' " + JSON.stringify(ir) + "\n",{mode:0o700});
    await chmod(compiler,0o700);
    await assert.rejects(
      compileOresToWasm({source,compiler,output,environment:"browser"}),
      /wasm32 target-marked IR/
    );
    await assert.rejects(stat(output),/ENOENT/);
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
});
