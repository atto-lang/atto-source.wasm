import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtempSync,readFileSync,rmSync,writeFileSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {compileOresToWasm} from "../scripts/compile-ores.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";

const root=resolve(fileURLToPath(new URL("..",import.meta.url)));
const compiler=process.env.ORESLANG_LLVM_COMPILER;
const compilerSha256=process.env.ORESLANG_LLVM_COMPILER_SHA256;
const required=process.env.ORESLANG_INVERTED_WASM_PARITY_REQUIRED==="1";
const sha256=b=>createHash("sha256").update(b).digest("hex");
const gitBlob=b=>createHash("sha1").update(
  Buffer.concat([Buffer.from("blob "+b.length+"\0"),b])).digest("hex");
const fixtures=[
 ["inverted-i64-swap-reuse.atto","8f5599a9e0b11ded2929110b4936441fceb2ef21",42n],
 ["inverted-i64-full-width.atto","29cb9983e63411db36ec9be9f6024ba56ce3ca57",4294967338n],
 ["inverted-i64-bounds-trap.atto","c3c87cfd2515707932734e183bb5768436526a96",null]
];

test("inverted compilation cannot be accidentally enabled, and opt-in requires a pin",async()=>{
 const example={
  compiler:"/not/a/compiler",source:"/not/a/source.atto",
  output:"/not/a/result.wasm"
 };
 await assert.rejects(compileOresToWasm({...example,experimentalInvertedI64:0}),
  /experimentalInvertedI64 must be a boolean/);
 await assert.rejects(compileOresToWasm({...example,experimentalInvertedI64:true}),
  /requires \.atto source, exact main and pinned compiler SHA-256/);
 await assert.rejects(compileOresToWasm({...example,experimentalInvertedI64:true,
  compilerSha256:"0".repeat(64),exportName:"not_main"}),
  /requires \.atto source, exact main and pinned compiler SHA-256/);
 await assert.rejects(compileOresToWasm({...example,experimentalInvertedI64:true,
  compilerSha256:"0".repeat(64),source:"/not/a/source.ores"}),
  /requires \.atto source, exact main and pinned compiler SHA-256/);
});

test("real pinned LLVM source -> wasm32 -> SHA-pinned isolated Worker guest",{
 skip:!compiler&&!required
},async()=>{
 assert.match(compiler||"",/^\//,"real compiler absolute path required");
 assert.match(compilerSha256||"",/^[0-9a-f]{64}$/,"approved compiler digest required");
 assert.match(process.env.ORESLANG_LLVM_SOURCE_SHA||"",/^[0-9a-f]{40}$/,"source tree provenance required");
 const compilerBytes=readFileSync(compiler);
 assert.equal(sha256(compilerBytes),compilerSha256,"compiler byte identity");
 const tmp=mkdtempSync(join(tmpdir(),"atto-inverted-wasm-real-"));
 try{
  for(const [name,blob,expected] of fixtures){
   const source=join(root,"tests/fixtures",name);
   const sourceBytes=readFileSync(source);
   assert.equal(gitBlob(sourceBytes),blob,"immutable Git fixture identity");
   const output=join(tmp,name+".wasm");
   const manifest=await compileOresToWasm({
    compiler,source,output,compilerSha256,environment:"browser",
    experimentalInvertedI64:true,clang:process.env.CLANG||"clang"
   });
   const wasm=readFileSync(output);
   assert.equal(sha256(wasm),manifest.wasmSha256,"pinned guest bytes");
   assert.equal(manifest.sourceSha256,sha256(sourceBytes));
   assert.ok(WebAssembly.validate(wasm),"actual compiled Wasm");
   const module=new WebAssembly.Module(wasm);
   assert.deepEqual(WebAssembly.Module.imports(module),[],"no host capabilities");
   assert.deepEqual(WebAssembly.Module.exports(module).map(x=>x.name+":"+x.kind).sort(),
    ["main:function","memory:memory"],"closed export surface");
   const instance=new WebAssembly.Instance(module);
   if(expected===null){
    assert.throws(()=>instance.exports.main(),WebAssembly.RuntimeError,
      "removed dense index must trap");
    await assert.rejects(runIsolatedCoreGuest(wasm,{
      expectedSha256:manifest.wasmSha256,timeoutMs:5000
    }),/guest|trap|failed|rejected|exit/i,
      "isolated Worker must refuse trapped guest");
   }else{
    assert.equal(instance.exports.main(),expected,"direct guest result");
    const observed=await runIsolatedCoreGuest(wasm,{
     expectedSha256:manifest.wasmSha256,timeoutMs:5000
    });
    assert.equal(observed.value,expected,"real isolated guest result");
    assert.equal(observed.admission.hostCapabilities,0);
   }
  }
  // Native compiler rejects inverted classes; opt-in bridge must propagate
  // its diagnostic and publish no artifact or metadata.
  const rejected=join(tmp,"bad-class.atto"), output=join(tmp,"bad-class.wasm");
  writeFileSync(rejected,`define inverted class Row as
    let value: int;
end
fnc main(): int { return 42; }
`,{mode:0o600,flag:"wx"});
  await assert.rejects(compileOresToWasm({
    compiler,source:rejected,output,compilerSha256,
    experimentalInvertedI64:true
  }),/DOP_INVERTED_CLASS_UNSUPPORTED/);
  assert.equal(existsSync(output),false,"rejected source published Wasm");
  assert.equal(existsSync(output+".provenance.json"),false,"rejected source published metadata");
  assert.equal(sha256(readFileSync(compiler)),compilerSha256,"compiler unchanged");
 }finally{rmSync(tmp,{recursive:true,force:true});}
});

test("must not mix experimental inverted MIR with checked-overflow witness", async () => {
 // The scalar checked-overflow contract has separate verified IR rules.
 // An experimental path that omits ordinary tree-shaking must not bypass it.
 await assert.rejects(compileOresToWasm({
  compiler:"/nonexistent/llvmc",source:"/nonexistent/main.atto",
  output:"/nonexistent/result.wasm",experimentalInvertedI64:true,
  checkedOverflowOperation:"sadd",compilerSha256:"0".repeat(64)
 }),/experimental inverted i64 cannot combine with checked-overflow witness/);
});
