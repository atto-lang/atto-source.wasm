import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile} from "node:fs/promises";
import {cleanupRealCompilerWorkspace} from "../scripts/cleanup-real-compiler.mjs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {compileOresToWasm} from "../scripts/compile-ores.mjs";

const compiler=process.env.ORESLANG_LLVM_COMPILER;
const required=process.env.ORESLANG_REQUIRE_REAL_COMPILER==="1"||process.env.ORESLANG_NUMERIC_PARITY_REQUIRED==="1";
const compilerSha256=process.env.ORESLANG_LLVM_COMPILER_SHA256;
const header="// oreslang:checked-i64-v1\n";

async function compileMain(t,expression){
  if(!compiler){
    assert.ok(!required,"real compiler required for checked-i64 execution");
    t.skip("set ORESLANG_LLVM_COMPILER to run real cross-backend parity");return null;
  }
  if(required) assert.match(compilerSha256||"",/^[a-f0-9]{64}$/,"required compiler SHA-256");
  const dir=await mkdtemp(join(tmpdir(),"oreslang-wasm-parity-"));
  t.after(()=>cleanupRealCompilerWorkspace(dir));
  const source=join(dir,"main.ores"), output=join(dir,"main.wasm");
  await writeFile(source,header+"pub fnc main(): int { return "+expression+"; }\n");
  await compileOresToWasm({compiler:resolve(compiler),compilerSha256,source,output});
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
  // Current merged cross-backend semantics: signed integer division truncates toward zero.
  ["positive integer division","7 / 2",3n],
  ["negative dividend division","-7 / 2",-3n],
  ["negative divisor division","7 / -2",-3n],
  ["two negative operands division","-7 / -2",3n],
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
]){
  test("checked-i64 cross-backend overflow traps: "+name,async t=>{
    const main=await compileMain(t,expression); if(!main)return;
    assert.throws(()=>main(),WebAssembly.RuntimeError);
  });
}

