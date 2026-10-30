import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {compileOresToWasm,readBoundedRegularFile} from "../scripts/compile-ores.mjs";

const compiler=process.env.ORESLANG_LLVM_COMPILER;
const requireReal=process.env.ORESLANG_REQUIRE_REAL_COMPILER==="1";
const header="// oreslang:checked-i64-v1\n";
let pinnedCompilerSha;

async function compilerPin(){
  if(!requireReal) return undefined;
  assert.ok(compiler,
    "ORESLANG_REQUIRE_REAL_COMPILER requires ORESLANG_LLVM_COMPILER; never skip required Math parity");
  assert.match(process.env.ORESLANG_LLVM_COMPILER_SHA256||"",/^[0-9a-f]{64}$/,
    "required Math parity needs exact compiler binary SHA-256");
  const declaredSource=process.env.ORESLANG_LLVM_SOURCE_SHA;
  if(declaredSource!==undefined){
    assert.match(declaredSource,/^[0-9a-f]{40}$/,
      "optional declared LLVM source commit must be a 40-hex SHA");
  }
  // A caller-supplied source SHA is metadata only. It is intentionally NOT
  // counted as source-to-binary provenance until a trusted build receipt binds
  // that source tree to the exact compiler bytes checked below.
  if(!pinnedCompilerSha){
    const bytes=(await readBoundedRegularFile(resolve(compiler),256*1024*1024)).bytes;
    pinnedCompilerSha=createHash("sha256").update(bytes).digest("hex");
    assert.equal(pinnedCompilerSha,process.env.ORESLANG_LLVM_COMPILER_SHA256,
      "required Math parity compiler bytes do not match the declared pin");
  }
  return pinnedCompilerSha;
}

async function compilePortableFixture(t,name){
  if(!compiler){
    if(requireReal) assert.fail(
      "ORESLANG_REQUIRE_REAL_COMPILER requires ORESLANG_LLVM_COMPILER; never skip required Math parity");
    t.skip("set ORESLANG_LLVM_COMPILER to run optional real cross-backend parity");return null;
  }
  const dir=await mkdtemp(join(tmpdir(),"oreslang-wasm-portable-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=fileURLToPath(new URL("./fixtures/numeric-v1/"+name,import.meta.url));
  const output=join(dir,"main.wasm");
  await compileOresToWasm({
    compiler:resolve(compiler),compilerSha256:await compilerPin(),source,output
  });
  const bytes=await readFile(output);
  const {instance}=await WebAssembly.instantiate(bytes,{});
  assert.equal(typeof instance.exports.main,"function");
  return instance.exports.main;
}

async function compileMain(t,expression){
  if(!compiler){
    if(requireReal) assert.fail(
      "ORESLANG_REQUIRE_REAL_COMPILER requires ORESLANG_LLVM_COMPILER; never skip required Math parity");
    t.skip("set ORESLANG_LLVM_COMPILER to run optional real cross-backend parity");return null;
  }
  const dir=await mkdtemp(join(tmpdir(),"oreslang-wasm-parity-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=join(dir,"main.ores"), output=join(dir,"main.wasm");
  await writeFile(source,header+"define pub fnc main(): int { return "+expression+"; }\n");
  await compileOresToWasm({compiler:resolve(compiler),compilerSha256:await compilerPin(),source,output});
  const bytes=await readFile(output);
  const {instance}=await WebAssembly.instantiate(bytes,{});
  assert.equal(typeof instance.exports.main,"function");
  return instance.exports.main;
}

test("portable numeric guest blob: Math i64 success",async t=>{
  const main=await compilePortableFixture(t,"math-i64-ok.ores"); if(!main)return;
  assert.equal(main(),84n);
});

for(const name of ["math-i64-abs-min.ores","math-i64-neg-min.ores"]){
  test("portable numeric guest blob traps: "+name,async t=>{
    const main=await compilePortableFixture(t,name); if(!main)return;
    assert.throws(()=>main(),WebAssembly.RuntimeError);
  });
}

for(const [name,expression,expected] of [
  ["precedence","2 + 3 * 4",14n],
  ["parentheses","(2 + 3) * 4",20n],
  ["negative","-7 + 3",-4n],
  ["max","9223372036854775807",9223372036854775807n],
  ["min","-9223372036854775808",-9223372036854775808n],
  ["zero","0",0n],
  ["signed multiplication","-7 * -6",42n],
  ["Math.abs negative","Math.abs(-42)",42n],
  ["Math.abs zero","Math.abs(0)",0n],
  ["Math.neg positive","Math.neg(42)",-42n],
  ["Math.neg negative","Math.neg(-42)",42n],
]){
  test("checked-i64 cross-backend scalar: "+name,async t=>{
    const main=await compileMain(t,expression); if(!main)return;
    assert.equal(main(),expected);
  });
}

for(const [name,expression] of [
  ["add overflow","9223372036854775807 + 1"],
  ["subtract overflow","-9223372036854775808 - 1"],
  ["multiply overflow","9223372036854775807 * 2"],
  ["unary negate minimum","-(-9223372036854775808)"],
  ["Math.abs minimum","Math.abs(-9223372036854775808)"],
  ["Math.neg minimum","Math.neg(-9223372036854775808)"],
]){
  test("checked-i64 cross-backend overflow traps: "+name,async t=>{
    const main=await compileMain(t,expression); if(!main)return;
    assert.throws(()=>main(),WebAssembly.RuntimeError);
  });
}

for(const numericType of ["bigint","decimal","f32","f64","float","i32","u64"]){
  test("unsupported numeric type fails before Wasm publication: "+numericType,async t=>{
    if(!compiler){
      if(requireReal) assert.fail(
        "ORESLANG_REQUIRE_REAL_COMPILER requires ORESLANG_LLVM_COMPILER; never skip required numeric admission");
      t.skip("set ORESLANG_LLVM_COMPILER to run optional real cross-backend parity");return;
    }
    const dir=await mkdtemp(join(tmpdir(),"oreslang-wasm-numeric-reject-"));
    t.after(()=>rm(dir,{recursive:true,force:true}));
    const source=join(dir,"main.ores"), output=join(dir,"main.wasm");
    await writeFile(source,header+"define pub fnc main("+numericType+" value): int { return 0; }\n");
    await assert.rejects(()=>compileOresToWasm({
      compiler:resolve(compiler),compilerSha256:await compilerPin(),source,output
    }));
    await assert.rejects(()=>readFile(output),
      "rejected precision type must not publish a Wasm artifact");
  });
}

test("int / int is not admitted as an i64 result",async t=>{
  if(!compiler){
    if(requireReal) assert.fail(
      "ORESLANG_REQUIRE_REAL_COMPILER requires ORESLANG_LLVM_COMPILER; never skip required Math parity");
    t.skip("set ORESLANG_LLVM_COMPILER to run optional real cross-backend parity");return;
  }
  const dir=await mkdtemp(join(tmpdir(),"oreslang-wasm-parity-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=join(dir,"main.ores"), output=join(dir,"main.wasm");
  await writeFile(source,header+"define pub fnc main(): int { return 7 / 2; }\n");
  await assert.rejects(()=>compileOresToWasm({compiler:resolve(compiler),compilerSha256:await compilerPin(),source,output}));
});
