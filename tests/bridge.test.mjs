import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,chmod,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {compileOresToWasm} from "../scripts/compile-ores.mjs";
const hash=b=>createHash("sha256").update(b).digest("hex");
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


test("bounded source graph is privately staged, hashed and order-independent",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"oreslang-wasm-graph-test-"));
 try{
  const compiler=join(dir,"graph-compiler.sh");
  const source=join(dir,"entry.ores"),math=join(dir,"math.ores"),helper=join(dir,"helper.ores");
  const outputA=join(dir,"graph-a.wasm"),outputB=join(dir,"graph-b.wasm");
  await writeFile(source,'import module Math from "./math"; pub fnc main():int{return Math.answer();}\n');
  await writeFile(math,'define pub module Math as pub fnc answer():int{return 42;} end\n');
  await writeFile(helper,'define module Helper as pub fnc value():int{return 1;} end\n');
  await writeFile(compiler,[
   "#!/bin/sh",
   'for last do :; done',
   'root=$(dirname "$last")',
   'test -f "$root/math.ores" || exit 41',
   'test -f "$root/lib/helper.ores" || exit 42',
   'grep -q "define pub module Math" "$root/math.ores" || exit 43',
   "printf 'target triple = \"wasm32-unknown-unknown\"\\ndefine i64 @main() { ret i64 42 }\\n'",
   ""
  ].join("\n"),{mode:0o700});
  await chmod(compiler,0o700);
  const compilerSha256=hash(await readFile(compiler));
  const first=await compileOresToWasm({
   compiler,compilerSha256,source,output:outputA,
   sourceDependencies:[
    {path:math,relativePath:"math.ores"},
    {path:helper,relativePath:"lib/helper.ores"}
   ]
  });
  const second=await compileOresToWasm({
   compiler,compilerSha256,source,output:outputB,
   sourceDependencies:[
    {path:helper,relativePath:"lib/helper.ores"},
    {path:math,relativePath:"math.ores"}
   ]
  });
  assert.match(first.sourceGraphSha256,/^[0-9a-f]{64}$/);
  assert.equal(first.sourceGraphSha256,second.sourceGraphSha256,
    "dependency ordering must not change graph identity");
  assert.deepEqual(first.sourceDependencies.map(x=>x.relativePath),
    ["math.ores","lib/helper.ores"]);
  assert.equal((new WebAssembly.Instance(
    new WebAssembly.Module(await readFile(outputA)))).exports.main(),42n);

  await assert.rejects(
   compileOresToWasm({
    compiler,source,output:join(dir,"unsafe.wasm"),
    sourceDependencies:[{path:math,relativePath:"../math.ores"}]
   }),/unsafe source dependency relativePath/);
  await assert.rejects(
   compileOresToWasm({
    compiler,source,output:join(dir,"alias.wasm"),
    sourceDependencies:[
     {path:math,relativePath:"math.ores"},
     {path:math,relativePath:"other.ores"}
    ]
   }),/aliases another compiler input/);
 }finally{await rm(dir,{recursive:true,force:true})}
});
