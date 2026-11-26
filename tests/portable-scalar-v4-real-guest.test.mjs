// Active v5: real LLVM compiler to Wasm guest, never a host arithmetic substitute.
// Filename retained for existing CI callers; historical v4 remains immutable.
// Missing compiler is a SKIP (not parity) unless required mode forbids it.
import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp,writeFile,readFile,rm,stat} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {compileOresToWasm,readBoundedRegularFile} from "../scripts/compile-ores.mjs";
import {assertNativeFrontendRejection} from "../scripts/verify-real-compiler.mjs";
import {semanticCompilerRejection} from "../src/oresllm-compiler-evidence.mjs";

const historicalV4=readFileSync(new URL("../contracts/parity/portable-scalar-v4-20261119.json",import.meta.url));
const manifestBytes=readFileSync(new URL("../contracts/parity/portable-scalar-v5-20261120.json",import.meta.url));
const corpus=JSON.parse(manifestBytes.toString("utf8"));
const canonicalGitBlob="e9b370f81efef07e7f2818d007486fea82c95b3d";
const gitBlobSha=bytes=>createHash("sha1").update("blob "+bytes.length+"\0").update(bytes).digest("hex");
const compiler=process.env.ORESLANG_LLVM_COMPILER;
const compilerSha256=process.env.ORESLANG_LLVM_COMPILER_SHA256;
const required=process.env.ORESLANG_REQUIRE_REAL_COMPILER==="1";
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
const all=[...corpus.positive,...corpus.compile_reject,...corpus.checked_overflow];

test("historical scalar v4 remains immutable; active v5 is unique and mode-separated",()=>{
  assert.equal(gitBlobSha(historicalV4),"8185a1b4bf0e0a776b4168cad4805fc40660327d");
  assert.equal(corpus.supersedes_git_blob,gitBlobSha(historicalV4));
  assert.equal(gitBlobSha(manifestBytes),canonicalGitBlob,"manifest drift across backends");
  assert.equal(corpus.schema_version,"2026-11-20.scalar-v5");
  assert.equal(corpus.scope,"import-free-pure-i64");
  assert.equal(corpus.positive.length,13);
  assert.equal(corpus.compile_reject.length,4);
  assert.equal(corpus.checked_overflow.length,4);
  assert.equal(new Set(all.map(x=>x.id)).size,21);
  for(const x of all) {
    assert.match(x.id,/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(x.expression.length>0 && x.expression.length<200);
    assert.doesNotMatch(x.expression,/\b(?:eval|require|import)\b/);
  }
});
async function guest(t,x,kind,returnKeyword="return"){
  if(!compiler && !compilerSha256){
    if(required) throw Error("required v5 guest proof missing compiler + sha256");
    t.skip("no pinned compiler; zero Oreslang guest evidence");
    return;
  }
  assert.ok(compiler&&compilerSha256,"incomplete compiler identity; fail closed");
  assert.match(compilerSha256,/^[0-9a-f]{64}$/);
  const dir=await mkdtemp(join(tmpdir(),"ores-wasm-scalar-v5-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=join(dir,"main.atto"),output=join(dir,"main.wasm");
  const bytes=Buffer.from("pub fnc main(): int { "+returnKeyword+" "+x.expression+"; }\n");
  await writeFile(source,bytes,{flag:"wx",mode:0o400});
  const snapshot=(await readBoundedRegularFile(resolve(compiler),256*1024*1024,"compiler snapshot unavailable")).bytes;
  assert.equal(hash(snapshot),compilerSha256,"compiler binary mismatch");
  const exactCompiler=join(dir,"compiler-exact");
  await writeFile(exactCompiler,snapshot,{flag:"wx",mode:0o500});
  const go=()=>compileOresToWasm({compiler:exactCompiler,compilerSha256,source,output,operatorProfile:"canonical-i64-v5"});
  if(kind==="compile_reject"){
    // A missing compiler, digest failure, timeout, or linker crash is NOT an
    // expected language rejection. Require the pinned compiler's source-stage
    // diagnostic before granting this negative Oreslang guest assertion.
    // The bridge is not a compiler oracle. Independently invoke the
    // exact snapshot and require a diagnosed source rejection with no IR.
    const result=spawnSync(exactCompiler,["--target=wasm32",source],{
      encoding:"utf8",timeout:30000,maxBuffer:4*1024*1024,
      env:{PATH:process.env.PATH??"/usr/bin:/bin",LANG:"C.UTF-8",LC_ALL:"C.UTF-8"}});
    assertNativeFrontendRejection(result);
    await assert.rejects(go(),error=>{
      assert.ok(semanticCompilerRejection(error) ||
        (["removed-percent-new","invalid-infix-return-caret","spaced-carets"].includes(x.id) &&
         String(error?.message).includes("ATTO_REMOVED_OPERATOR")),
        "infrastructure failure misclassified as source rejection: "+x.id);
      return true;
    });
    await assert.rejects(stat(output),{code:"ENOENT"},"rejected source must not publish an artifact");
    return;
  }
  const receipt=await go();
  assert.equal(receipt.compilerSha256,compilerSha256,"compiler binary mismatch");
  assert.equal(receipt.sourceSha256,hash(bytes),"source provenance mismatch");
  const wasm=await readFile(output);
  assert.ok(wasm.length>8,"no empty published binary");
  assert.equal(receipt.wasmSha256,hash(wasm),"artifact digest mismatch");
  const {instance}=await WebAssembly.instantiate(wasm,{});
  assert.equal(typeof instance.exports.main,"function");
  if(kind==="positive"){
    assert.equal(instance.exports.main(),BigInt(x.expected),"incorrect native wasm32 i64: "+x.id);
  }else{
    assert.throws(()=>instance.exports.main(),WebAssembly.RuntimeError,"checked overflow must trap: "+x.id);
  }
}
for(const x of corpus.positive) test("Wasm v5 positive "+x.id,t=>guest(t,x,"positive"));
for(const x of corpus.compile_reject) test("Wasm v5 compiler reject "+x.id,t=>guest(t,x,"compile_reject"));
for(const x of corpus.checked_overflow) test("Wasm v5 overflow trap "+x.id,t=>guest(t,x,"checked_overflow"));
test("Wasm v5 statement-leading caret return",t=>guest(t,{id:"prefix-caret-return",expression:"40 + 2",expected:"42"},"positive","^"));
test("Wasm v5 Boolean double-caret is not integer XOR",t=>guest(t,{id:"bool-double-caret",expression:"true ^^ false"},"compile_reject"));
test("Wasm v5 spaced caret is not integer XOR",t=>guest(t,{id:"spaced-carets",expression:"11 ^ ^ 4"},"compile_reject"));
test("required v5 parity never skips missing compiler",()=>{
  if(required) assert.ok(compiler&&compilerSha256,"required compiler identity missing");
  if(compiler||compilerSha256) assert.ok(compiler&&compilerSha256,"partial compiler pin");
});
