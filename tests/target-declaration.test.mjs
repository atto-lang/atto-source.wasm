import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,chmod,stat,readFile,rm} from "node:fs/promises";
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

test("legacy/non-manifest builds cannot downgrade to unmarked native IR", async () => {
  const dir = await mkdtemp(join(tmpdir(),"ores-wasm-legacy-target-"));
  try {
    const source = join(dir,"guest.ores"), compiler = join(dir,"stub-compiler.sh"), output = join(dir,"guest.wasm");
    await writeFile(source,"pub fnc main(): int { return 42; }\n");
    await writeFile(compiler,"#!/bin/sh\nprintf 'define i64 @main() { ret i64 42 }\\n'\n",{mode:0o700});
    await assert.rejects(
      compileOresToWasm({source,compiler,output,publication:"legacy"}),
      /wasm32 target-marked IR/
    );
    await assert.rejects(stat(output),/ENOENT/);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("unmanifested compiler bridge also requests wasm32 target and executes real Wasm", async () => {
  const dir = await mkdtemp(join(tmpdir(),"ores-wasm-legacy-positive-"));
  try {
    const source = join(dir,"guest.ores"),compiler=join(dir,"require-target.sh"),output=join(dir,"guest.wasm");
    await writeFile(source,"pub fnc main(): int { return 42; }\n");
    // Test double checks invocation shape only; this is not native Oreslang
    // compiler verification. The resulting Wasm is linked by real Clang.
    const compilerScript=[
      "#!/bin/sh",
      'test "$1" = "--tree-shake" || exit 31',
      'test "$2" = "--tree-shake-root=main" || exit 32',
      'test "$3" = "--target=wasm32" || exit 33',
      'test -f "$4" || exit 34',
      "printf 'target triple = \"wasm32-unknown-unknown\"\\ndefine i64 @main() { ret i64 42 }\\n'",
      ""
    ].join("\n");
    await writeFile(compiler,compilerScript,{mode:0o700});
    const r=await compileOresToWasm({source,compiler,output,publication:"legacy"});
    const wasm=await readFile(output);
    assert.equal(r.wasmBytes,wasm.length);
    assert.equal(new WebAssembly.Instance(new WebAssembly.Module(wasm)).exports.main(),42n);
    await assert.rejects(stat(output+".artifact.json"),/ENOENT/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
