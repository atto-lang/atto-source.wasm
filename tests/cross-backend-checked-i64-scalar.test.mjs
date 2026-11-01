import test from "node:test";
import {createHash} from "node:crypto";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {createReadStream} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {compileOresToWasm} from "../scripts/compile-ores.mjs";

const compiler=process.env.ORESLANG_LLVM_COMPILER;
const parityRequired=process.env.ORESLANG_SCALAR_PARITY_REQUIRED==="1";
async function verifyCompilerSha256(path,expected){
  assert.match(expected??"",/^[0-9a-f]{64}$/,
    "strict wasm32 scalar parity requires a lowercase 64-byte-hex SHA-256 pin");
  const actual=createHash("sha256");
  for await(const chunk of createReadStream(resolve(path)))actual.update(chunk);
  assert.equal(actual.digest("hex"),expected,
    "LLVM compiler executable changed without reviewed source identity");
}
async function requirePinnedCompilerInParityMode(){
  if(!parityRequired)return;
  assert(compiler,"strict scalar parity requires an actual LLVM compiler");
  await verifyCompilerSha256(compiler,process.env.ORESLANG_LLVM_COMPILER_SHA256);
}

function unavailable(t){
  if(compiler)return false;
  if(parityRequired)assert.fail("real LLVM-to-Wasm compiler required for scalar parity; skipping forbidden");
  t.skip("not executed: ORESLANG_LLVM_COMPILER is not configured");
  return true;
}
const header="// oreslang:checked-i64-v1\n";
const waveSourceSha256={
  "34": "2d186d0c400c23c6fcdf1df963580351eacea82250097a1cd083a1cc308b40f5",
  "35": "73e5fc703df0b0d3af6898c156ff105ec28e8dfc639f2a02ccca0f1cd3c69dd8",
  "36": "2ca62fbe11d05cb219a4be255669842994c279e0e0a5208fbc3d3a0e4c047d29",
  "37": "efb740b31d72bfdc1eecc8a7eb87a7b84c8961f444fbbcc08a142ca54cf7c97b",
  "38": "391467d7baf7b84b339a63e55be2395d9a8a4d92b5719f249df428b34bac7ccd",
  "39": "d1fa2dc614cd61c442ab1bfa5683fac50cc9d72139e0dcdf0a67b3610d427bd6",
  "40": "0322dc2a7d48fed12d917aaaf2a50c025b77402a2b21fdbb87224fece59b44b0",
  "41": "3483cb15d4b2f2c24f90ba65e55e886b59eaea2190aa9c18f8ed10badba04e76",
  "50": "939b28fccd280d8a3690ebd4d874f263a9ddfe0c87d420d93b9bd684ffe34074",
  "51": "873112bfda242442d29a8b2ba9f74bc494db44e4e66ac51484ad886786bb525b",
  "52": "2ee8ae2204d348d177a995e1086543fbc9fcff3d66c80827d40468f2953a9157",
  "53": "171928949cd43a61f2072f311f94e27f697968848d07b1b90affc9e061d3c41e",
  "54": "61cf977237ae559e2a759efde340e31b62f95a244702b94f8641ff24931ebecf",
  "55": "a1da8a0e27b1a72a6371447868cd75d192f3b0da18122c53ac48cfc848f2320f",
  "56": "ea84b5d71bbb8a7356fe87b70c04a0518da28c53fb2e271d2b6429bbe6a44581",
  "57": "ba3cd5f0d90f7b6f9c4776561f5b7149dfd2c7d420492fe98df3f249a3fb9922"
};


async function compileMain(t,expression,name){
  if(unavailable(t))return null;
  await requirePinnedCompilerInParityMode();
  const dir=await mkdtemp(join(tmpdir(),"oreslang-wasm-parity-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=join(dir,"main.ores"), output=join(dir,"main.wasm");
  const waveNames=[
    "grouped precedence","double negation","left associative subtraction",
    "signed multiplication","negative multiplication chain","i64 max minus large",
    "i64 min plus max","nested grouping",
    "left associative product","paired negative differences","grouped zero difference",
    "six times seven","parenthesized negative product","max self cancellation",
    "min self cancellation","unit multiplication group"
  ];
  const caseIds=["34","35","36","37","38","39","40","41","50","51","52","53","54","55","56","57"];
  const waveIndex=name?.startsWith("wave/")?waveNames.indexOf(name.slice(5)):-1;
  if(name?.startsWith("wave/"))assert(waveIndex>=0,"unrecognized shared Oreslang parity case");
  const waveId=waveIndex<0?null:caseIds[waveIndex];
  const guestSource=waveId&&Object.hasOwn(waveSourceSha256,waveId)
    ? "// "+waveId+": candidate source-identical checked-i64 scalar program.\n"
      + "// Expected integer result 42; guest execution on each backend is unverified.\n"
      + "pub fnc main(): int { return "+expression+"; }\n"
    : header+"define pub fnc main(): int { return "+expression+"; }\n";
  if(waveId){
    assert.equal(createHash("sha256").update(guestSource,"utf8").digest("hex"),
      waveSourceSha256[waveId],"Wasm guest source bytes differ from shared Oreslang corpus");
  }
  await writeFile(source,guestSource);
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
  ["wave/left associative product","2 * 3 * 7",42n],
  ["wave/paired negative differences","(0 - 7) * (0 - 6)",42n],
  ["wave/grouped zero difference","(21 + 21) + (0 - 0)",42n],
  ["wave/six times seven","6 * 7",42n],
  ["wave/parenthesized negative product","(-7) * (-6)",42n],
  ["wave/max self cancellation","9223372036854775807 - 9223372036854775807 + 42",42n],
  ["wave/min self cancellation","-9223372036854775808 - (-9223372036854775808) + 42",42n],
  ["wave/unit multiplication group","(100 - 58) * (0 + 1)",42n],
]){
  test("checked-i64 cross-backend scalar: "+name,async t=>{
    const main=await compileMain(t,expression,name); if(!main)return;
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
  await requirePinnedCompilerInParityMode();
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
    await requirePinnedCompilerInParityMode();
    const dir=await mkdtemp(join(tmpdir(),"oreslang-wasm-reject-"));
    t.after(()=>rm(dir,{recursive:true,force:true}));
    const source=join(dir,"negative.ores"),output=join(dir,"negative.wasm");
    await writeFile(source,header+"pub fnc main(): int { return "+expression+"; }\n");
    await assert.rejects(()=>compileOresToWasm({compiler:resolve(compiler),source,output}));
    await assert.rejects(()=>readFile(output),"rejected compiler must not publish Wasm");
  });
}

test("LLVM binary pin rejects altered bytes and absent or malformed digests",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"oreslang-wasm-compiler-pin-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const binary=join(dir,"compiler.bin");
  await writeFile(binary,"reviewed-compiler-v1");
  const reviewed=createHash("sha256").update("reviewed-compiler-v1").digest("hex");
  await verifyCompilerSha256(binary,reviewed);
  await writeFile(binary,"modified-compiler-v2");
  await assert.rejects(()=>verifyCompilerSha256(binary,reviewed),/changed without reviewed/);
  await assert.rejects(()=>verifyCompilerSha256(binary,""),/lowercase 64-byte-hex/);
  await assert.rejects(()=>verifyCompilerSha256(binary,"A".repeat(64)),/lowercase 64-byte-hex/);
});
