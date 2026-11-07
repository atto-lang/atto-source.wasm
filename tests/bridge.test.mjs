import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,chmod,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {compileOresToWasm,wasmCoreCompilerArgs} from "../scripts/compile-ores.mjs";
const hash=b=>createHash("sha256").update(b).digest("hex");
test("Wasm bridge explicitly requires Core-only compiler admission",()=>{
 const args=wasmCoreCompilerArgs("/tmp/atto-numeric.atto");
 assert.deepEqual(args,["--library-profile=core","--tree-shake","--tree-shake-root=main",
                        "--target=wasm32","/tmp/atto-numeric.atto"]);
 assert.equal(args.filter(x=>x.startsWith("--library-profile=")).length,1);
 assert.equal(args.filter(x=>x.startsWith("--target=")).length,1);
 assert.ok(!args.some(x=>x==="--allocator-provider=bounded-arena"));
 for(const bad of ["numeric.atto","/tmp/source.txt","/tmp/source.atto\0evil",null,"", "/tmp/guest.json", "/tmp/no-extension"])
  assert.throws(()=>wasmCoreCompilerArgs(bad),/(absolute staged|requires)/);
});

test("Wasm compiler argv is checked by the actually executed pinned tool",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"atto-wasm-exact-argv-"));
 try{
  const compiler=join(dir,"core-argv-compiler.sh");
  const source=join(dir,"core-guest.atto");
  const output=join(dir,"core-guest.wasm");
  // This script is deliberately a stub and MUST NOT be reported as
  // compiler-backed AttoLang evidence. It verifies actual bridge invocation.
  const lines=[
   "#!/bin/sh",
   "set -eu",
   "test \"$#\" -eq 5",
   "test \"$1\" = '--library-profile=core'",
   "test \"$2\" = '--tree-shake'",
   "test \"$3\" = '--tree-shake-root=main'",
   "test \"$4\" = '--target=wasm32'",
   "case \"$5\" in *.atto) ;; *) exit 88 ;; esac",
   "printf 'target triple = \"wasm32-unknown-unknown\"\\ndefine i64 @main() { ret i64 42 }\\n'",
  ].join("\n")+"\n";
  await writeFile(compiler,lines,{mode:0o700});
  await chmod(compiler,0o700);
  await writeFile(source,"pub fnc main(): int { return 42; }\n");
  const digest=hash(await readFile(compiler));
  const result=await compileOresToWasm({compiler,source,output,compilerSha256:digest});
  const binary=await readFile(output);
  assert.equal(result.compilerSha256,digest);
  assert.equal(result.importCount,0);
  assert.equal((new WebAssembly.Instance(new WebAssembly.Module(binary))).exports.main(),42n);
  assert.equal(JSON.parse(await readFile(output+".provenance.json","utf8")).wasmSha256,hash(binary));
 }finally{await rm(dir,{recursive:true,force:true})}
});

test("LLVM IR prepublication rejects forged target/main before creating any Wasm artifact",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"atto-wasm-invalid-ir-"));
 try{
  const source=join(dir,"candidate.atto");
  await writeFile(source,"pub fnc main():int{return 42;}\n");
  const invalid=[
   ["host-target",'target triple = "x86_64-unknown-linux-gnu"\ndefine i64 @main() { ret i64 42 }\n',/wasm32 target-marked IR/],
   ["comment-only",'; target triple = "wasm32-unknown-unknown"\ndefine i64 @main() { ret i64 42 }\n',/wasm32 target-marked IR/],
   ["duplicate-triple",'target triple = "wasm32-unknown-unknown"\ntarget triple = "wasm32-unknown-unknown"\ndefine i64 @main() { ret i64 42 }\n',/wasm32 target-marked IR/],
   ["missing-main",'target triple = "wasm32-unknown-unknown"\ndefine i64 @not_main() { ret i64 42 }\n',/expected i64 @main/]
  ];
  for(const [label,ir,diagnostic] of invalid){
   const compiler=join(dir,label+".sh"),output=join(dir,label+".wasm");
   const shell="#!/bin/sh\ncat <<'ATTO_INVALID_IR'\n"+ir+"ATTO_INVALID_IR\n";
   await writeFile(compiler,shell,{mode:0o700});
   await chmod(compiler,0o700);
   const pin=hash(await readFile(compiler));
   await assert.rejects(()=>compileOresToWasm({
     compiler,source,output,compilerSha256:pin
   }),diagnostic,label);
   await assert.rejects(readFile(output),{code:"ENOENT"},label+" generated Wasm");
   await assert.rejects(readFile(output+".provenance.json"),{code:"ENOENT"},label+" published provenance");
   await assert.rejects(readFile(output+".artifact.json"),{code:"ENOENT"},label+" published manifest");
  }
 }finally{await rm(dir,{recursive:true,force:true})}
});

test("real Clang wasm32 bridge accepts verified IR and records hashes (stub compiler only)",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"oreslang-wasm-bridge-test-"));
 try{
  const compiler=join(dir,"stub-compiler.sh"),source=join(dir,"source.ores"),output=join(dir,"app.wasm");
  const stub="#!/bin/sh\nprintf 'target triple = \"wasm32-unknown-unknown\"\\ndefine i64 @main() { ret i64 42 }\\n'\n";
  await writeFile(compiler,stub,{mode:0o700});
  await chmod(compiler,0o700);
  await writeFile(source,"pub fnc main(): int { return 42; }\n");
  const pin=hash(await readFile(compiler));
  const r=await compileOresToWasm({compiler,source,output,compilerSha256:pin});
  assert.equal(r.compilerSha256,pin);
  assert.equal(r.importCount,0);
  assert.equal(r.kind,"llvm-ores-to-wasm32-core-experimental");
  assert.equal(r.treeShaking,"llvm-direct-calls-v1");
  const wasm=await readFile(output);
  assert.equal(WebAssembly.validate(wasm),true);
  assert.equal((new WebAssembly.Instance(new WebAssembly.Module(wasm))).exports.main(),42n);
  assert.equal(JSON.parse(await readFile(output+".provenance.json","utf8")).wasmSha256,hash(wasm));
  await assert.rejects(()=>compileOresToWasm({compiler,source,output:join(dir,"bad.wasm"),compilerSha256:"0".repeat(64)}),/SHA-256/);
 }finally{await rm(dir,{recursive:true,force:true})}
});
test("real native Oreslang compiler integration, opt-in and never simulated",{
 skip:!process.env.ORESLANG_LLVM_COMPILER
},async()=>{
 const dir=await mkdtemp(join(tmpdir(),"oreslang-real-llvm-wasm-"));
 try{
  const compiler=process.env.ORESLANG_LLVM_COMPILER;
  const source=new URL("../examples/native-int.ores",import.meta.url).pathname;
  const output=join(dir,"real-oreslang-guest.wasm");
  const r=await compileOresToWasm({compiler,source,output,
   compilerSha256:process.env.ORESLANG_LLVM_COMPILER_SHA256});
  assert.equal(r.importCount,0);
  const bytes=await readFile(output);
  assert.equal((new WebAssembly.Instance(new WebAssembly.Module(bytes))).exports.main(),42n);
 }finally{await rm(dir,{recursive:true,force:true})}
});

test("source supervisors never invoke the native compiler or publish Wasm", async () => {
  const dir=await mkdtemp(join(tmpdir(),"oreslang-supervisor-source-denial-"));
  try{
    const compiler=join(dir,"compiler.sh");
    const sentinel=join(dir,"compiler-was-invoked");
    const source=join(dir,"guest.ores");
    const output=join(dir,"guest.wasm");
    // The bridge should reject source supervisor authority before executing
    // even this local trusted test compiler, and before artifact staging.
    await writeFile(compiler,"#!/bin/sh\\ntouch "+JSON.stringify(sentinel)+"\\nexit 0\\n",{mode:0o700});
    await chmod(compiler,0o700);
    const pin=hash(await readFile(compiler));
    for (const invalid of [
      "define supervisor S1 as on_panic(f: Failure): void { return; } end",
      "pub define supervisor S1 as end",
      "define pub supervisor S1 as end",
      "define /* trivia */ supervisor S1 as end"
    ]) {
      await writeFile(source,invalid,{mode:0o600});
      await assert.rejects(
        () => compileOresToWasm({compiler,source,output,compilerSha256:pin}),
        /WASM source supervisor unsupported: no typed Failure or CONTROL lowering/,
        invalid);
      await assert.rejects(readFile(sentinel), {code:"ENOENT"});
      await assert.rejects(readFile(output), {code:"ENOENT"});
      await assert.rejects(readFile(output+".provenance.json"), {code:"ENOENT"});
    }
  }finally{await rm(dir,{recursive:true,force:true});}
});
