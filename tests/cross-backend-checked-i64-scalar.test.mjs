import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {compileOresToWasm} from "../scripts/compile-ores.mjs";

const compiler=process.env.ORESLANG_LLVM_COMPILER;
const header="// oreslang:checked-i64-v1\n";

async function compileMain(t,expression){
  if(!compiler){
    assert.equal(process.env.ORESLANG_REQUIRE_REAL_COMPILER,undefined,
      "required real-compiler parity must not silently skip without ORESLANG_LLVM_COMPILER");
    t.skip("set ORESLANG_LLVM_COMPILER to run real cross-backend parity");
    return null;
  }
  const dir=await mkdtemp(join(tmpdir(),"oreslang-wasm-parity-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=join(dir,"main.ores"), output=join(dir,"main.wasm");
  await writeFile(source,header+"define pub fnc main(): int { return "+expression+"; }\n");
  await compileOresToWasm({compiler:resolve(compiler),source,output});
  const bytes=await readFile(output);
  const {instance}=await WebAssembly.instantiate(bytes,{});
  assert.equal(typeof instance.exports.main,"function");
  return instance.exports.main;
}

for(const [name,expression,expected] of [
  ["precedence","2 + 3 * 4",14n],
  ["parentheses","(2 + 3) * 4",20n],
  ["negative","-7 + 3",-4n],
  ["max","9223372036854775807",9223372036854775807n],
  ["min","-9223372036854775808",-9223372036854775808n],
  ["zero","0",0n],
  ["signed multiplication","-7 * -6",42n],
  ["shared precedence","4 + 6 * (5 - 1)",28n],
  ["shared nested parentheses","7 * (4 + 2)",42n],
  ["shared left associativity","42 - 10 - 2",30n],
  ["shared parenthesized precedence","(2 + 3) * 8",40n],
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
  ["multiply min by negative one","-9223372036854775808 * -1"],
  ["nested multiply overflow","7 * (9223372036854775807 - 1)"],
]){
  test("checked-i64 cross-backend overflow traps: "+name,async t=>{
    const main=await compileMain(t,expression); if(!main)return;
    assert.throws(()=>main(),WebAssembly.RuntimeError);
  });
}

test("int / int is not admitted as an i64 result",async t=>{
  if(!compiler){
    assert.equal(process.env.ORESLANG_REQUIRE_REAL_COMPILER,undefined,
      "required division-rejection parity cannot skip without ORESLANG_LLVM_COMPILER");
    t.skip("set ORESLANG_LLVM_COMPILER to run real cross-backend parity");
    return;
  }
  const dir=await mkdtemp(join(tmpdir(),"oreslang-wasm-parity-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=join(dir,"main.ores"), output=join(dir,"main.wasm");
  await writeFile(source,header+"define pub fnc main(): int { return 7 / 2; }\n");
  await assert.rejects(()=>compileOresToWasm({compiler:resolve(compiler),source,output}));
});
