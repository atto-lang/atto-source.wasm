import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,chmod,readFile,rm,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {compileOresToWasm,assertScalarSourceHasNoImports} from "../scripts/compile-ores.mjs";
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
  const wasm=await readFile(output);
  assert.equal(WebAssembly.validate(wasm),true);
  assert.equal((new WebAssembly.Instance(new WebAssembly.Module(wasm))).exports.main(),42n);
  assert.equal(JSON.parse(await readFile(output+".provenance.json","utf8")).wasmSha256,hash(wasm));
  await assert.rejects(()=>compileOresToWasm({compiler,source,output:join(dir,"bad.wasm"),compilerSha256:"0".repeat(64)}),/SHA-256/);
 }finally{await rm(dir,{recursive:true,force:true})}
});

test("scalar bridge rejects every source-import spelling even with a valid-looking compiler",async()=>{
 const imported=[
  '+/lib/helper','pkg:dep/helper','./helper','../helper',
  'common/helper','.hidden/helper','@/legacy',
  '+/nested/lib/child','+/nested/parent-alias','+/dangling/lib/child',
 ];
 for(const specifier of imported){
  const src='import fnc helper from "'+specifier+'";\nfnc main():int{return 42;}\n';
  assert.throws(()=>assertScalarSourceHasNoImports(Buffer.from(src)),
    /source imports require verified complete Wasm module graph/,specifier);
 }
 for(const src of [
  'fnc main():int{return 42;} // import from "+/fake"\n',
  '/* import fnc fake from "+/fake"; */ fnc main():int{return 42;}',
  'fnc main():int{return 42;} // importedFunction\n',
  'fnc main():int{return 42;} // "import"\n',
  'fnc main():int{return 42;} // good_import\n',
  'fnc main():int{return 42;} /* import */\n',
 ]){
  assert.doesNotThrow(()=>assertScalarSourceHasNoImports(Buffer.from(src)));
 }
 // CR, CRLF, Unicode line separators must not make imports disappear
 // inside the source graph gate. No compiler invocation is needed here.
 for(const ending of ['\\r','\\r\\n','\\n','\\u2028','\\u2029']){
  const newline=JSON.parse('"'+ending+'"');
  assert.throws(()=>assertScalarSourceHasNoImports(Buffer.from(
   '// pretend import in a comment'+newline+'import fnc helper from "./other";')),
   /source imports require verified complete Wasm module graph/,ending);
 }
 for(const src of [
  '/* outer /* inner */ import in outer */ fnc main():int{return 42;}',
  '/* first /* second /* third */ still second */ still first */ fnc main():int{return 42;}',
 ])assert.doesNotThrow(()=>assertScalarSourceHasNoImports(Buffer.from(src)),
  'nested Oreslang comments must not create phantom imports');
 assert.throws(()=>assertScalarSourceHasNoImports(Buffer.from(
  '/* outer /* inner */ rest */ import fnc helper from "./real";')),
  /source imports require verified complete Wasm module graph/);
 assert.throws(()=>assertScalarSourceHasNoImports(Buffer.from('/* outer /* inner */')),
  /unterminated Oreslang block comment/);
 assert.throws(()=>assertScalarSourceHasNoImports(Buffer.from('/*'.repeat(129)+'*/'.repeat(129))),
  /nesting limit exceeded/);
 assert.throws(()=>assertScalarSourceHasNoImports(Buffer.concat([Buffer.from('fnc main():int{return 42;} // '),Buffer.from([0])])), 
  /NUL byte/);
 assert.throws(()=>assertScalarSourceHasNoImports(Buffer.from('/* unclosed')),
  /unterminated Oreslang block comment/);
 assert.throws(()=>assertScalarSourceHasNoImports(Buffer.from('fnc main():int { "unclosed')),
  /unterminated Oreslang string/);
 assert.throws(()=>assertScalarSourceHasNoImports(Buffer.from([0xc0,0xaf])),
  /valid/i,"invalid UTF-8 must not bypass the scanner");
 const dir=await mkdtemp(join(tmpdir(),"oreslang-scalar-import-admission-"));
 try{
  const source=join(dir,"source.ores"),compiler=join(dir,"compiler.sh");
  const marker=join(dir,"compiler-executed"),output=join(dir,"guest.wasm");
  await writeFile(source,'// harmless comment\\rimport fnc helper from "+/lib/helper";\\nfnc main():int{return 42;}\\n'.replaceAll('\\r','\r').replaceAll('\\n','\n'));
  await writeFile(compiler,'#!/bin/sh\ntouch "'+marker+'"\nprintf "target triple = \\"wasm32-unknown-unknown\\"\\n"\n',{mode:0o700});
  await chmod(compiler,0o700);
  await assert.rejects(()=>compileOresToWasm({compiler,source,output}),
    /source imports require verified complete Wasm module graph/);
  await assert.rejects(stat(marker),{code:"ENOENT"},
    "rejected imports must not execute even a stub compiler");
  await assert.rejects(stat(output),{code:"ENOENT"},
    "rejected imports must not publish a guest artifact");
  await assert.rejects(stat(output+".provenance.json"),{code:"ENOENT"},
    "rejected imports must not publish provenance metadata");
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
