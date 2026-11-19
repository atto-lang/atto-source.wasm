// v3: real LLVM compiler to Wasm guest, never a host arithmetic substitute.
// Missing compiler is a SKIP (not parity) unless required mode forbids it.
import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp,writeFile,readFile,rm,stat} from "node:fs/promises";
import {readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {compileOresToWasm} from "../scripts/compile-ores.mjs";
import {semanticCompilerRejection} from "../src/oresllm-compiler-evidence.mjs";

const manifestBytes=readFileSync(new URL("../contracts/parity/portable-scalar-v3-20261101.json",import.meta.url));
const corpus=JSON.parse(manifestBytes.toString("utf8"));
const canonicalGitBlob="cd51c7320812d1ee032a211890cb427c984b2ea2";
const gitBlobSha=bytes=>createHash("sha1").update("blob "+bytes.length+"\0").update(bytes).digest("hex");
const compiler=process.env.ORESLANG_LLVM_COMPILER;
const compilerSha256=process.env.ORESLANG_LLVM_COMPILER_SHA256;
const required=process.env.ORESLANG_REQUIRE_REAL_COMPILER==="1";
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
const all=[...corpus.positive,...corpus.compile_reject,...corpus.checked_overflow];

test("scalar v3 manifest is unique, complete and mode-separated",()=>{
  assert.equal(gitBlobSha(manifestBytes),canonicalGitBlob,"manifest drift across backends");
  assert.equal(corpus.schema_version,"2026-11-01.scalar-v3");
  assert.equal(corpus.scope,"import-free-pure-i64");
  assert.equal(corpus.positive.length,12);
  assert.equal(corpus.compile_reject.length,5);
  assert.equal(corpus.checked_overflow.length,4);
  assert.equal(new Set(all.map(x=>x.id)).size,21);
  for(const x of all) {
    assert.match(x.id,/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(x.expression.length>0 && x.expression.length<200);
    assert.doesNotMatch(x.expression,/\b(?:eval|require|import)\b/);
  }
});
async function guest(t,x,kind){
  if(!compiler && !compilerSha256){
    if(required) throw Error("required v3 guest proof missing compiler + sha256");
    t.skip("no pinned compiler; zero Oreslang guest evidence");
    return;
  }
  assert.ok(compiler&&compilerSha256,"incomplete compiler identity; fail closed");
  assert.match(compilerSha256,/^[0-9a-f]{64}$/);
  const dir=await mkdtemp(join(tmpdir(),"ores-wasm-scalar-v3-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=join(dir,"main.atto"),output=join(dir,"main.wasm");
  const bytes=Buffer.from("pub fnc main(): int { return "+x.expression+"; }\n");
  await writeFile(source,bytes,{flag:"wx",mode:0o400});
  const go=()=>compileOresToWasm({compiler:resolve(compiler),compilerSha256,source,output});
  if(kind==="compile_reject"){
    // A missing compiler, digest failure, timeout, or linker crash is NOT an
    // expected language rejection. Require the pinned compiler's source-stage
    // diagnostic before granting this negative Oreslang guest assertion.
    await assert.rejects(go(),error=>{
      assert.equal(semanticCompilerRejection(error),true,
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
for(const x of corpus.positive) test("Wasm v3 positive "+x.id,t=>guest(t,x,"positive"));
for(const x of corpus.compile_reject) test("Wasm v3 compiler reject "+x.id,t=>guest(t,x,"compile_reject"));
for(const x of corpus.checked_overflow) test("Wasm v3 overflow trap "+x.id,t=>guest(t,x,"checked_overflow"));
test("required v3 parity never skips missing compiler",()=>{
  if(required) assert.ok(compiler&&compilerSha256,"required compiler identity missing");
  if(compiler||compilerSha256) assert.ok(compiler&&compilerSha256,"partial compiler pin");
});
