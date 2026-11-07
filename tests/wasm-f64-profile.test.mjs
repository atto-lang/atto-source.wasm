import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {admitCoreGuest} from "../src/guest-admission.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";

const PROFILE="core-wasm.f64-v1";
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
const triple='target triple = "wasm32-unknown-unknown"\n';
function compile(ir,{allowUndefined=false}={}){
  const dir=mkdtempSync(join(tmpdir(),"atto-wasm-f64-"));
  try{
    const output=join(dir,"guest.wasm");
    const args=["--target=wasm32","-x","ir","-Oz","-nostdlib",
      "-Wl,--no-entry","-Wl,--export=main","-Wl,--initial-memory=131072",
      "-Wl,--max-memory=131072"];
    if(allowUndefined)args.push("-Wl,--allow-undefined");
    args.push("-o",output,"-");
    const compiled=spawnSync(process.env.CLANG||"clang",args,
      {input:triple+ir,encoding:"utf8",timeout:30000,maxBuffer:4*1024*1024});
    assert.ifError(compiled.error);
    assert.equal(compiled.status,0,compiled.stderr);
    return readFileSync(output);
  } finally {rmSync(dir,{recursive:true,force:true});}
}
const f64Return=value=>'define double @main() { ret double '+value+' }\n';
const cases=[
  ["binary64 arithmetic","define double @main() { %sum = fadd double 1.500000e+00, 2.250000e+00\n ret double %sum }\n",3.75],
  ["negative zero",f64Return("-0.000000e+00"),-0],
  ["positive infinity",f64Return("0x7FF0000000000000"),Infinity],
  ["quiet NaN",f64Return("0x7FF8000000000000"),NaN]
];
for(const [name,ir,expected] of cases){
  test("real clang-linked f64 Wasm executes in isolated Worker: "+name,async()=>{
    const wasm=compile(ir),pin=sha(wasm);
    assert.equal(WebAssembly.validate(wasm),true);
    assert.throws(()=>admitCoreGuest(wasm),/exact \(\) -> i64 signature/,
      "default i64 must not auto-promote an f64 entry");
    const metadata=admitCoreGuest(wasm,{expectedSha256:pin,profile:PROFILE});
    assert.equal(metadata.profile,PROFILE);
    assert.equal(metadata.imports,0);
    assert.equal(metadata.hostCapabilities,0);
    const observed=await runIsolatedCoreGuest(wasm,{profile:PROFILE,expectedSha256:pin,timeoutMs:5000});
    assert.equal(observed.admission.sha256,pin);
    assert.equal(observed.admission.profile,PROFILE);
    assert.ok(Object.is(observed.value,expected),name+" value/sign must survive Worker message");
    await assert.rejects(runIsolatedCoreGuest(wasm,{profile:PROFILE,expectedSha256:"f".repeat(64)}),
      /SHA-256 mismatch/);
  });
}
test("strict opt-in profile rejects i64, f32 and unexpected f64 parameters",async()=>{
  const wrong=[
    ["i64", "define i64 @main() { ret i64 42 }\n"],
    ["f32", "define float @main() { ret float 1.500000e+00 }\n"],
    ["f64 with argument", "define double @main(double %x) { ret double %x }\n"]
  ];
  for(const [name,ir] of wrong){
    const wasm=compile(ir);
    assert.throws(()=>admitCoreGuest(wasm,{profile:PROFILE}),/exact \(\) -> f64 signature/,name);
    await assert.rejects(runIsolatedCoreGuest(wasm,{profile:PROFILE}),/exact \(\) -> f64 signature/,name);
  }
});
test("f64 profile refuses unknown names, imported host calls and inherited capabilities",async()=>{
  const wasm=compile(f64Return("3.750000e+00"));
  for(const invalid of ["f64","core-wasm.f32-v1","core-wasm.i64-v2",null]){
    assert.throws(()=>admitCoreGuest(wasm,{profile:invalid}),/unsupported core Wasm scalar profile/);
    await assert.rejects(runIsolatedCoreGuest(wasm,{profile:invalid}),/unsupported core Wasm scalar profile/);
  }
  const imported=compile('declare double @forbidden()\ndefine double @main() { %v = call double @forbidden()\n ret double %v }\n',
    {allowUndefined:true});
  assert.ok(WebAssembly.Module.imports(new WebAssembly.Module(imported)).length>0);
  assert.throws(()=>admitCoreGuest(imported,{profile:PROFILE}),/host imports denied/);
  await assert.rejects(runIsolatedCoreGuest(imported,{profile:PROFILE}),/host imports denied/);
  await assert.rejects(runIsolatedCoreGuest(wasm,{profile:PROFILE,guestNetworkIo:true}),
    /unknown guest runner option/);
});
test("f64 CLI prints negative zero without JSON number rounding",()=>{
  const wasm=compile(f64Return("-0.000000e+00"));
  const dir=mkdtempSync(join(tmpdir(),"atto-wasm-f64-cli-"));
  try{
    const output=join(dir,"guest.wasm");writeFileSync(output,wasm);
    const cli=fileURLToPath(new URL("../scripts/run-guest.mjs",import.meta.url));
    const execution=spawnSync(process.execPath,[cli,
      "--wasm="+output,"--sha256="+sha(wasm),"--profile="+PROFILE],
      {encoding:"utf8",timeout:10000,maxBuffer:1024*1024});
    assert.ifError(execution.error);
    assert.equal(execution.status,0,execution.stderr);
    const result=JSON.parse(execution.stdout);
    assert.equal(result.value,"-0");
    assert.equal(result.resultType,"f64");
    assert.equal(result.admission.profile,PROFILE);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
