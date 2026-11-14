import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp,readFile,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {compileOresToWasm,readBoundedRegularFile} from "../scripts/compile-ores.mjs";
import {readAtomicRelease} from "../scripts/atomic-release.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";

const cases=JSON.parse(await readFile(
  new URL("../contracts/optional-formal-order-v1/cases.json",import.meta.url),"utf8"));
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
const compiler=process.env.ORESLANG_LLVM_COMPILER;
const required=process.env.ORESLANG_FORMAL_ORDER_PARITY_REQUIRED==="1" ||
  process.env.ORESLANG_REQUIRE_REAL_COMPILER==="1";

test("formal declaration order Wasm corpus is versioned and byte-pinned (host only)",()=>{
  assert.equal(cases.schema,"attolang.wasm.optional-formal-order.v1");
  assert.equal(cases.status,"TARGET_NOT_EXECUTED");
  assert.equal(cases.llvm_compiler_source_head,"e8b3d4331e3d9738ab95a34c635d2210ea9b00fe");
  assert.equal(cases.fixtures.length,7);
  assert.equal(new Set(cases.fixtures.map(c=>c.id)).size,7);
  for(const item of cases.fixtures){
    assert.ok(item.source.startsWith("fnc add("));
    assert.equal(sha(Buffer.from(item.source)),item.sha256,item.id);
    if(item.kind==="execute")assert.equal(item.expected_exit,42);
    else assert.match(item.diagnostic,/^E_[A-Z_]+$/);
  }
});

test("real pinned LLVM compiler to Wasm guests execute both required scalar formal orders and reject unsupported omissions",{
  skip:!compiler&&!required,timeout:180000
},async()=>{
  assert.ok(compiler,"required real Wasm parity cannot skip without ORESLANG_LLVM_COMPILER");
  const compilerSha256=process.env.ORESLANG_LLVM_COMPILER_SHA256;
  assert.match(compilerSha256||"",/^[a-f0-9]{64}$/,"compiler binary SHA256 is mandatory");
  assert.equal(process.env.ORESLANG_LLVM_SOURCE_SHA,cases.llvm_compiler_source_head,
    "compile only from the reviewed LLVM formal-order head");
  const info=await readBoundedRegularFile(resolve(compiler),256*1024*1024);
  assert.equal(sha(info.bytes),compilerSha256,"binary compiler hash does not match pin");
  const dir=await mkdtemp(join(tmpdir(),"atto-formal-order-wasm-"));
  try{
    for(const item of cases.fixtures){
      const input=join(dir,item.id+".atto");
      const output=join(dir,item.id+".wasm");
      await writeFile(input,item.source,{flag:"wx",mode:0o600});
      assert.equal(sha(await readFile(input)),item.sha256);
      const build=()=>compileOresToWasm({
        compiler:resolve(compiler),compilerSha256,source:input,output,
        environment:"browser",publication:"atomic"
      });
      if(item.kind==="execute"){
        const result=await build();
        const released=await readAtomicRelease(output);
        assert.equal(released.manifest.wasmSha256,result.wasmSha256);
        assert.deepEqual(released.manifest.requiredCapabilities,[]);
        const actual=await runIsolatedCoreGuest(released.wasm,{
          expectedSha256:result.wasmSha256,timeoutMs:5000
        });
        assert.equal(actual.value,BigInt(item.expected_exit),
          item.id+": compiled guest returned wrong value");
      }else{
        await assert.rejects(build,e=>typeof e?.message==="string" &&
          e.message.includes(item.diagnostic),
          item.id+": unsupported formal escaped source compiler");
        await assert.rejects(()=>readFile(output),{code:"ENOENT"},
          item.id+": rejected source published a Wasm artifact");
      }
      assert.equal(sha(await readFile(input)),item.sha256,
        item.id+": compiler mutated source");
    }
  }finally{await rm(dir,{recursive:true,force:true})}
});
