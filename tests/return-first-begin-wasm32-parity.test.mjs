// The WASM backend deliberately does NOT contain a second Oreslang parser:
// it delegates source syntax to the pinned native LLVM compiler. This gate
// demands real wasm32 codegen and guest execution, not a JS source rewrite.
import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdtemp, writeFile, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, isAbsolute} from "node:path";
import {compileOresToWasm, readBoundedRegularFile} from "../scripts/compile-ores.mjs";
import {readAtomicRelease} from "../scripts/atomic-release.mjs";
import {cleanupRealCompilerWorkspace} from "../scripts/cleanup-real-compiler.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";
import {assertNativeFrontendRejection} from "../scripts/verify-real-compiler.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const headers = Object.freeze([
  ["arrow-bare", "int <- main()"],
  ["bullet-bare", "int• main()"],
  ["arrow-fnc", "fnc int <- main()"],
  ["bullet-fnc", "fnc int• main()"]
]);
const terminators = Object.freeze([
  ["plain", "end"], ["dot", "end."], ["semicolon", "end;"]
]);
const cases = Object.freeze(headers.flatMap(([name,header]) =>
  terminators.map(([suffix,closer])=>Object.freeze([name+"-"+suffix,header,closer]))));
const negatives = Object.freeze([
  "int <- main() begin return 42; end",
  "int <- main()\nbegin return 42;\nend",
  "int <- main()\nbegin\nreturn 42;",
  "int <- main()\nbegin\nreturn 42;\nend..",
  "int <- main()\nbegin\nreturn 42;\nend. extra"
]);
const scalar = (header, closer) => header + "\nbegin\n  return 42;\n" + closer + "\n";
const demand = process.env.ORESLANG_RETURN_FIRST_WASM_PARITY_REQUIRED ?? "0";
if (!["0","1"].includes(demand)) throw Error("ORESLANG_RETURN_FIRST_WASM_PARITY_REQUIRED must be 0 or 1");

function compilerIdentity(env) {
  if (!isAbsolute(env.ORESLANG_LLVM_COMPILER || ""))
    throw Error("return-first parity requires absolute ORESLANG_LLVM_COMPILER");
  if (!/^[a-f0-9]{64}$/.test(env.ORESLANG_LLVM_COMPILER_SHA256 || ""))
    throw Error("return-first parity requires pinned LLVM compiler SHA-256");
  if (!/^[a-f0-9]{40}$/.test(env.ORESLANG_LLVM_SOURCE_SHA || ""))
    throw Error("return-first parity requires exact LLVM source commit");
  if (!/^[a-f0-9]{40}$/.test(env.ORESLANG_RETURN_FIRST_WASM_EXPECTED_HEAD || ""))
    throw Error("return-first parity requires exact WASM source commit");
  return {compiler:env.ORESLANG_LLVM_COMPILER,
    hash:env.ORESLANG_LLVM_COMPILER_SHA256,
    llvmHead:env.ORESLANG_LLVM_SOURCE_SHA,
    wasmHead:env.ORESLANG_RETURN_FIRST_WASM_EXPECTED_HEAD};
}

test("source fixture matrix is unambiguously the four return-first spellings (STATIC ONLY)", () => {
  assert.equal(cases.length,12);
  assert.equal(new Set(cases.map(([name])=>name)).size,12);
  for (const [,header,closer] of cases) {
    assert.match(header,/^(?:fnc )?int(?: <- |• )main\(\)$/);
    assert.match(closer,/^end[.;]?$/);
    assert.match(scalar(header,closer),/\nbegin\n  return 42;\nend/);
  }
  assert.equal(negatives.length,5);
});

test("required real compiler identity fails closed", () => {
  assert.throws(()=>compilerIdentity({}),/absolute/);
  assert.throws(()=>compilerIdentity({ORESLANG_LLVM_COMPILER:"/missing"}),/SHA-256/);
});

const ready=Boolean(process.env.ORESLANG_LLVM_COMPILER);
test("real pinned native LLVM -> wasm32 -> isolated i64 guest syntax parity",{
  skip:!ready && demand!=="1",
  timeout:360000
},async()=>{
  const {compiler,hash,llvmHead,wasmHead}=compilerIdentity(process.env);
  const git=spawnSync("git",["rev-parse","HEAD"],{encoding:"utf8",timeout:5000});
  assert.ifError(git.error);
  assert.equal(git.status,0);
  assert.equal(git.stdout.trim(),wasmHead,"WASM working tree head changed");
  const bytes=(await readBoundedRegularFile(compiler,256*1024*1024,
    "pinned compiler missing or too large")).bytes;
  assert.equal(sha256(bytes),hash,"native compiler digest drift");
  const tmp=await mkdtemp(join(tmpdir(),"ores-return-first-wasm32-"));
  try {
    const pinned=join(tmp,"compiler");
    await writeFile(pinned,bytes,{flag:"wx",mode:0o500});
    let executed=0,rejected=0;
    for (const [name,header,closer] of cases) {
      const source=join(tmp,name+".atto"),output=join(tmp,name+".wasm");
      const sourceBytes=Buffer.from(scalar(header,closer),"utf8");
      await writeFile(source,sourceBytes,{flag:"wx",mode:0o400});
      const built=await compileOresToWasm({compiler:pinned,
        compilerSha256:hash,source,output,environment:"browser",publication:"atomic"});
      assert.equal(built.sourceSha256,sha256(sourceBytes));
      assert.equal(built.compilerSha256,hash);
      const release=await readAtomicRelease(output);
      assert.equal(sha256(release.wasm),built.wasmSha256);
      assert.deepEqual(release.manifest.imports,[]);
      assert.deepEqual(release.manifest.requiredCapabilities,[]);
      const result=await runIsolatedCoreGuest(release.wasm,{expectedSha256:built.wasmSha256,timeoutMs:5000});
      assert.equal(result.value,42n,name);
      assert.equal(result.admission.imports,0);
      assert.equal(result.admission.hostCapabilities,0);
      executed++;
    }
    for (let index=0;index<negatives.length;index++) {
      const source=join(tmp,"negative-"+index+".atto");
      const output=join(tmp,"negative-"+index+".wasm");
      await writeFile(source,negatives[index],{flag:"wx",mode:0o400});
      const rejectedCompiler=spawnSync(pinned,["--target=wasm32",source],{
        encoding:"utf8",timeout:30000,maxBuffer:4*1024*1024,
        env:{PATH:process.env.PATH||"/usr/bin:/bin",LANG:"C.UTF-8",LC_ALL:"C.UTF-8"}
      });
      assertNativeFrontendRejection(rejectedCompiler);
      await assert.rejects(compileOresToWasm({compiler:pinned,
        compilerSha256:hash,source,output,environment:"browser",publication:"atomic"}));
      await assert.rejects(stat(output),{code:"ENOENT"});
      rejected++;
    }
    assert.equal(executed,12);
    assert.equal(rejected,5);
    console.log("RETURN_FIRST_WASM32_EXECUTED=12 NATIVE_REJECTIONS=5 LLVM_HEAD="+llvmHead+
      " WASM_HEAD="+wasmHead+" JAVA_DIFFERENTIAL=NOT_EXECUTED");
  }finally{
    await cleanupRealCompilerWorkspace(tmp);
  }
});
