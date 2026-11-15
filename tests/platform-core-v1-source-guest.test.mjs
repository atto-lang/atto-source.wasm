// Strict LLVM-to-wasm32 guest conformance of the exact canonical source files.
// A missing native LLVM compiler is a failed gate in strict mode, NEVER a pass.
// In default npm test, actual guest cases SKIP and are not parity evidence.
import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile,lstat,mkdtemp,rm} from "node:fs/promises";
import {createReadStream} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {compileOresToWasm} from "../scripts/compile-ores.mjs";

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),"../contracts/platform-core-v1");
const REQUIRED=process.env.ORESLANG_PLATFORM_CORE_V1_REQUIRED==="1";
const COMPILER=process.env.ORESLANG_LLVM_COMPILER;
const PIN=process.env.ORESLANG_LLVM_COMPILER_SHA256;
const POS=[
 "arith-precedence.ores","signed-minimum.ores","max-minus-five.ores",
 "two-negative-factors.ores","nested-unary.ores","negative-product.ores",
 "eager-checked-int.ores"
];
const NEG=[
 "reject-unknown-symbol.ores","reject-string-as-int.ores","reject-overflow.ores",
 "reject-xor-operator.ores","reject-no-value-return.ores"
];
const CANONICAL_GIT_BLOBS=Object.freeze({
 "arith-precedence.ores":"14f0a6fde3c55ead28f361da6c0e40279344137a",
 "signed-minimum.ores":"450ebee951733d3f0b567413e70724155d26ce13",
 "max-minus-five.ores":"ea1932dd800fdcf3ef00a01549ce6565d7691ade",
 "two-negative-factors.ores":"d83e07867159bb3f5b1027a0689f7eeefa84ac88",
 "nested-unary.ores":"c6aa564c5bd4ce38c5e5fcc1e96cec8cea58c6d3",
 "negative-product.ores":"ba664537993dd3bb808f0d3453bd01f5435cc098",
 "eager-checked-int.ores":"b95fd94f36da98a8972f665eda126b46159de0f9",
 "reject-unknown-symbol.ores":"fb17d2b5a662d435c367c682abbd5af7807f1e48",
 "reject-string-as-int.ores":"494a5d02d86c7d8f6222c25e1ca33eb7f92c1fba",
 "reject-overflow.ores":"eed3113842125b1d2a295a11e3cc01a5c1e3da00",
 "reject-xor-operator.ores":"e7f5e47a28219f1f43cb1e18c7f50d45c089a6c4",
 "reject-no-value-return.ores":"8cce1a3e24bec592834089d228f1047d61f510f0"
});
function gitBlobSha(bytes){
 return createHash("sha1").update(Buffer.from("blob "+bytes.length+String.fromCharCode(0))).update(bytes).digest("hex");
}

async function fixture(name){
 assert.match(name,/^[a-z][a-z0-9-]*\.ores$/);
 const path=join(ROOT,name);
 const stats=await lstat(path);
 assert(stats.isFile() && !stats.isSymbolicLink() && stats.nlink===1,
  "fixture cannot be a link or non-regular file");
 assert(stats.size>0 && stats.size<=1024*1024,"bounded source fixture required");
 return {path,bytes:await readFile(path)};
}
async function manifest(){
 const path=join(ROOT,"manifest.json");
 const stat=await lstat(path);
 assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<65536,
  "canonical regular manifest required");
 const data=JSON.parse(await readFile(path,"utf8"));
 assert.equal(data.schema,"oreslang.platform-core.v1");
 assert.match(data.scope,/no backend support is asserted/);
 assert.deepEqual(data.positive.map(x=>x.file),POS);
 assert.deepEqual(data.negative.map(x=>x.file),NEG);
 assert.equal(new Set([...POS,...NEG]).size,POS.length+NEG.length);
 for(const row of data.positive)assert.match(row.expected_stdout,/^-?[0-9]+\n$/);
 for(const row of data.negative)assert.equal(row.expected_exit,"nonzero");
 return data;
}
async function pinnedCompiler(){
 assert(COMPILER && COMPILER.startsWith("/"),"strict Wasm parity requires an absolute real LLVM compiler path");
 assert.match(PIN??"",/^[a-f0-9]{64}$/,"strict Wasm parity requires exact compiler SHA-256");
 const hash=createHash("sha256");
 for await(const chunk of createReadStream(resolve(COMPILER)))hash.update(chunk);
 assert.equal(hash.digest("hex"),PIN,"LLVM compiler binary changed since review");
 return resolve(COMPILER);
}
async function requireRunner(t){
 if(!REQUIRED){t.skip("NOT_EXECUTED: set ORESLANG_PLATFORM_CORE_V1_REQUIRED=1 with a pinned real LLVM compiler");return null}
 return await pinnedCompiler();
}
async function guest(compiler,path,t){
 const dir=await mkdtemp(join(tmpdir(),"ores-platform-core-wasm-"));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const output=join(dir,"case.wasm");
 await compileOresToWasm({compiler,source:path,output,compilerSha256:PIN});
 const bytes=await readFile(output);
 const module=new WebAssembly.Module(bytes);
 assert.deepEqual(WebAssembly.Module.imports(module),[],
  "scalar parity requires zero Wasm host imports");
 const instance=await WebAssembly.instantiate(module,{});
 assert.equal(typeof instance.exports.main,"function","missing compiled native guest main");
 return instance.exports.main;
}

test("canonical platform-core contract is pinned locally, not evidence of guest execution",async()=>{
 await manifest();
 for(const name of [...POS,...NEG]){
  const {bytes}=await fixture(name);
  assert.equal(gitBlobSha(bytes),CANONICAL_GIT_BLOBS[name],
   "canonical source blob differs from Java and LLVM references");
  assert.match(new TextDecoder("utf-8",{fatal:true}).decode(bytes),
   /^pub fnc main\(\): int \{/,"fixture must use unmodified canonical entrypoint");
 }
});

test("strict mode rejects missing or altered LLVM compiler pin",async()=>{
 if(!REQUIRED)return;
 await pinnedCompiler();
});

for(const [index,name] of POS.entries()){
 test("real LLVM-to-Wasm canonical guest positive: "+name,async t=>{
  const compiler=await requireRunner(t);if(!compiler)return;
  const cases=await manifest();
  const {path}=await fixture(name);
  const main=await guest(compiler,path,t);
  const expected=BigInt(cases.positive[index].expected_stdout.trim());
  assert.equal(main(),expected,"full-width checked-i64 guest result mismatch");
 });
}
for(const name of NEG){
 test("real LLVM-to-Wasm canonical guest negative: "+name,async t=>{
  const compiler=await requireRunner(t);if(!compiler)return;
  const {path}=await fixture(name);
  if(name==="reject-overflow.ores"){
   const main=await guest(compiler,path,t);
   assert.throws(()=>main(),WebAssembly.RuntimeError,
    "overflow must trap rather than wrap");
   return;
  }
  const dir=await mkdtemp(join(tmpdir(),"ores-platform-core-reject-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const output=join(dir,"should-not-publish.wasm");
  await assert.rejects(()=>compileOresToWasm({
   compiler,source:path,output,compilerSha256:PIN
  }),"negative fixture compiled successfully");
  await assert.rejects(()=>readFile(output),{code:"ENOENT"},
   "rejected source must publish no guest module");
 });
}
