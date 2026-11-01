import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {compileOresToWasm} from "../scripts/compile-ores.mjs";

const compiler=process.env.ORESLANG_LLVM_COMPILER;
const parityRequired=process.env.ORESLANG_SCALAR_PARITY_REQUIRED==="1";
function unavailable(t){
  if(compiler)return false;
  if(parityRequired)assert.fail("real LLVM-to-Wasm compiler required for scalar parity; skipping forbidden");
  t.skip("not executed: ORESLANG_LLVM_COMPILER is not configured");
  return true;
}
const header="// oreslang:checked-i64-v1\n";

async function compileMain(t,expression){
  if(unavailable(t))return null;
  const dir=await mkdtemp(join(tmpdir(),"oreslang-wasm-parity-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=join(dir,"main.ores"), output=join(dir,"main.wasm");
  await writeFile(source,header+"define pub fnc main(): int { return "+expression+"; }\n");
  await compileOresToWasm({compiler:resolve(compiler),source,output});
  const bytes=await readFile(output);
  // Scalar guests must be self-contained; an import cannot stand in for
  // the Oreslang main implementation or a hidden host arithmetic oracle.
  const module=new WebAssembly.Module(bytes);
  assert.deepEqual(WebAssembly.Module.imports(module),[],"unexpected host import in scalar guest");
  const instance=await WebAssembly.instantiate(module,{});
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
  ["wave/grouped precedence","(2 + 3) * 8 + 2",42n],
  ["wave/double negation","-(-42)",42n],
  ["wave/left associative subtraction","(100 - 16) - 42",42n],
  ["wave/signed multiplication","-7 * -6",42n],
  ["wave/negative multiplication chain","(7 - 14) * -6",42n],
  ["wave/i64 max minus large","9223372036854775807 - 9223372036854775765",42n],
  ["wave/i64 min plus max","-9223372036854775808 + 9223372036854775807 + 43",42n],
  ["wave/nested grouping","2 * (3 + 4) * 3",42n],
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

test("int / int is not admitted as an i64 result",async t=>{
  if(unavailable(t))return;
  const dir=await mkdtemp(join(tmpdir(),"oreslang-wasm-parity-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=join(dir,"main.ores"), output=join(dir,"main.wasm");
  await writeFile(source,header+"define pub fnc main(): int { return 7 / 2; }\n");
  await assert.rejects(()=>compileOresToWasm({compiler:resolve(compiler),source,output}));
});

// Explicit boundary probes, including checked runtime failure and strict compiler rejection.
// All skip when LLVM compiler is absent; a skipped test is never evidence of parity.
for(const [name,expression] of [
  ["overflowing literal","9223372036854775808"],
  ["removed xor operator","5 ^ 3"],
]){
  test("five-backend scalar rejection: "+name,async t=>{
    if(unavailable(t))return;
    const dir=await mkdtemp(join(tmpdir(),"oreslang-wasm-reject-"));
    t.after(()=>rm(dir,{recursive:true,force:true}));
    const source=join(dir,"negative.ores"),output=join(dir,"negative.wasm");
    await writeFile(source,header+"pub fnc main(): int { return "+expression+"; }\n");
    await assert.rejects(()=>compileOresToWasm({compiler:resolve(compiler),source,output}));
    await assert.rejects(()=>readFile(output),"rejected compiler must not publish Wasm");
  });
}
