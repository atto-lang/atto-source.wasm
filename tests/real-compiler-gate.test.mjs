import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
const path = fileURLToPath(new URL("../scripts/verify-real-compiler.mjs",import.meta.url));
const realLlvmWorkflow = fileURLToPath(new URL("../.github/workflows/real-llvm.yml",import.meta.url));
const hardenedGeneratorLlvmHead = "ae82a3fd6a40bc13581f9f0e3b722e0f4203818e";

test("real LLVM workflow pins the hardened generator compiler head consistently", () => {
  const workflow = readFileSync(realLlvmWorkflow, "utf8");
  assert.match(workflow, new RegExp("ORESLANG_LLVM_SOURCE_SHA: " + hardenedGeneratorLlvmHead));
  assert.match(workflow, new RegExp("ref: " + hardenedGeneratorLlvmHead));
  assert.equal(workflow.split(hardenedGeneratorLlvmHead).length - 1, 2,
    "workflow source attestation and checkout ref must be the same exact head");
});
test("missing real native compiler fails instead of silently skipping", () => {
  const env = {...process.env};
  for (const name of ["ORESLANG_LLVM_COMPILER","ORESLANG_LLVM_COMPILER_SHA256","ORESLANG_LLVM_SOURCE_SHA"])
    delete env[name];
  const r = spawnSync(process.execPath,[path],{env,encoding:"utf8",timeout:15000});
  assert.equal(r.status,1);
  assert.match(r.stderr,/ORESLANG_LLVM_COMPILER must be an absolute compiler executable path/);
  assert.doesNotMatch(r.stdout,/"status":\s*"verified"/);
});

test("invalid real-compiler SHA is refused before any executable is read", async () => {
  const {verifyRealCompiler} = await import("../scripts/verify-real-compiler.mjs");
  await assert.rejects(
    verifyRealCompiler({compiler:process.execPath,
      compilerSha256:"bad",llvmSourceSha:"0".repeat(40)}),
    /ORESLANG_LLVM_COMPILER_SHA256 is required/
  );
});
test("invalid source-commit attestation is refused before compiler execution", async () => {
  const {verifyRealCompiler} = await import("../scripts/verify-real-compiler.mjs");
  await assert.rejects(
    verifyRealCompiler({compiler:process.execPath,
      compilerSha256:"f".repeat(64),llvmSourceSha:"bad"}),
    /ORESLANG_LLVM_SOURCE_SHA is required/
  );
});

test("native compiler must report a diagnostic instead of crashing or leaking IR", async () => {
  const {assertNativeFrontendRejection} = await import("../scripts/verify-real-compiler.mjs");
  const diagnosed = {status:1,stdout:"",stderr:"oreslang-llvmc: unknown variable missing_identifier",error:undefined,signal:null};
  assert.equal(assertNativeFrontendRejection(diagnosed), true);
  for (const invalid of [
    {...diagnosed,signal:"SIGSEGV",status:null},
    {...diagnosed,stderr:""},
    {...diagnosed,status:2},
    {...diagnosed,stdout:"define i64 @main() { ret i64 42 }"}
  ]) {
    assert.throws(() => assertNativeFrontendRejection(invalid), /diagnosed error/);
  }
});

test("generator-v1 real-compiler gate requires the compiler-owned diagnostic", async () => {
  const {assertGeneratorV1FrontendRejection} =
    await import("../scripts/verify-real-compiler.mjs");
  const diagnosed = {
    status:1, signal:null, error:undefined, stdout:"",
    stderr:"oreslang-llvmc: native generator v1 requires iterator-frame, ownership and LLVM continuation lowering at byte 4"
  };
  assert.equal(assertGeneratorV1FrontendRejection(diagnosed), true);
  assert.throws(() => assertGeneratorV1FrontendRejection({
    ...diagnosed, stderr:"oreslang-llvmc: expected fnc or routine at byte 4"
  }), /required compiler-owned gate/);
});

test("generator-v1 async and suspend gates require their dedicated compiler diagnostics", async () => {
  const {assertGeneratorV1FrontendRejection} =
    await import("../scripts/verify-real-compiler.mjs");
  for (const diagnostic of [
    "native async gen* requires scheduler-owned async iterator continuation lowering",
    "native suspend gen* requires scheduler-owned async iterator continuation lowering"
  ]) {
    const diagnosed = {
      status:1, signal:null, error:undefined, stdout:"",
      stderr:"oreslang-llvmc: " + diagnostic
    };
    assert.equal(assertGeneratorV1FrontendRejection(diagnosed, diagnostic), true);
    assert.throws(() => assertGeneratorV1FrontendRejection({
      ...diagnosed,
      stderr:"oreslang-llvmc: native generator v1 requires iterator-frame, ownership and LLVM continuation lowering"
    }, diagnostic), /required compiler-owned gate/);
  }
});

test("generator-v1 wasm32 gate requires backend capability diagnostic", async () => {
  const {assertGeneratorV1WasmRejection} =
    await import("../scripts/verify-real-compiler.mjs");
  const expected =
    "native generator v1 is not yet admitted for wasm32/Cortex-M targets";
  const diagnosed = {
    status:1, signal:null, error:undefined, stdout:"",
    stderr:"oreslang-llvmc: " + expected
  };
  assert.equal(assertGeneratorV1WasmRejection(diagnosed), true);
  assert.throws(() => assertGeneratorV1WasmRejection({
    ...diagnosed,
    stderr:"oreslang-llvmc: native generator v1 requires iterator-frame, ownership and LLVM continuation lowering"
  }), /required wasm32 compiler gate/);
  assert.throws(() => assertGeneratorV1WasmRejection({
    ...diagnosed,
    stdout:"define i32 @fake() { ret i32 0 }"
  }), /diagnosed error/);
});

test("inverted real-compiler gate requires native declaration rejection", async () => {
  const {assertInvertedFrontendRejection} =
    await import("../scripts/verify-real-compiler.mjs");
  for (const stderr of [
    "oreslang-llvmc: INVERTED_BACKEND_UNSUPPORTED: native inverted class requires lowering at byte 7",
    "oreslang-llvmc: expected 'module', 'class' or 'actor' at byte 7",
    "oreslang-llvmc: expected 'class', 'actor', or built-in MaxActorThreads enum at byte 7"
  ]) {
    assert.equal(assertInvertedFrontendRejection({
      status:1,signal:null,error:undefined,stdout:"",stderr
    }), true);
  }
  assert.throws(() => assertInvertedFrontendRejection({
    status:1,signal:null,error:undefined,stdout:"",
    stderr:"oreslang-llvmc: unrelated arithmetic failure"
  }), /inverted-class source did not fail/);
});

test("select real-compiler gate requires LLVM capability diagnostic and no IR", async () => {
  const {assertSelectFrontendRejection} =
    await import("../scripts/verify-real-compiler.mjs");
  const diagnosed = {
    status:1, signal:null, error:undefined, stdout:"",
    stderr:"oreslang-llvmc: native async/channel/select boundary unsupported at byte 17"
  };
  assert.equal(assertSelectFrontendRejection(diagnosed), true);
  assert.throws(() => assertSelectFrontendRejection({
    ...diagnosed, stderr:"oreslang-llvmc: unexpected token select at byte 17"
  }), /LLVM async\/channel\/select capability gate/);
  assert.throws(() => assertSelectFrontendRejection({
    ...diagnosed, stdout:"define i64 @main() { ret i64 0 }"
  }), /diagnosed error/);
});

test("tuple-v2 real-compiler gate requires semantic diagnostic, not generic failure", async () => {
  const {assertTupleV2FrontendRejection} =
    await import("../scripts/verify-real-compiler.mjs");
  const expected =
    "native positional tuple parameter requires verified readonly-slot and optional-tail lowering";
  const diagnosed = {
    status:1, signal:null, error:undefined, stdout:"",
    stderr:"oreslang-llvmc: " + expected + " at byte 9"
  };
  assert.equal(assertTupleV2FrontendRejection(diagnosed, expected), true);
  assert.throws(() => assertTupleV2FrontendRejection({
    ...diagnosed, stderr:"oreslang-llvmc: unexpected token at byte 9"
  }, expected), /required compiler-owned gate/);
  assert.throws(() => assertTupleV2FrontendRejection({
    ...diagnosed, stdout:"define i64 @fake() { ret i64 0 }"
  }, expected), /diagnosed error/);
});

test("real frontend diagnostics require whitespace, not a literal backslash-s", async () => {
  const {assertNativeFrontendRejection} = await import("../scripts/verify-real-compiler.mjs");
  assert.equal(assertNativeFrontendRejection({
    status:1, signal:null, error:undefined, stdout:"",
    stderr:"oreslang-llvmc: unknown variable missing_identifier"
  }),true);
  assert.throws(() => assertNativeFrontendRejection({
    status:1, signal:null, error:undefined, stdout:"",
    stderr:"oreslang-llvmc:\\\\s+forged"
  }), /diagnosed error/);
});

test("real compiler workspace cleanup unseals readonly releases without following links", {
  skip: process.platform === "win32"
}, async () => {
  const {mkdtemp,mkdir,writeFile,chmod,symlink,readFile,stat,rm} =
    await import("node:fs/promises");
  const {tmpdir} = await import("node:os");
  const {join} = await import("node:path");
  const {cleanupRealCompilerWorkspace} = await import("../scripts/cleanup-real-compiler.mjs");
  const privateRoot = await mkdtemp(join(tmpdir(),"ores-test-work-clean-"));
  const outside = await mkdtemp(join(tmpdir(),"ores-test-outside-"));
  try {
    const sealed = join(privateRoot,"guest.wasm.releases","sealed");
    await mkdir(sealed,{recursive:true});
    await writeFile(join(sealed,"artifact.json"),"sealed");
    await writeFile(join(outside,"do-not-touch"),"important");
    await symlink(outside,join(sealed,"external-link"),"dir");
    await chmod(sealed,0o500);
    await cleanupRealCompilerWorkspace(privateRoot);
    await assert.rejects(stat(privateRoot),{code:"ENOENT"});
    assert.equal(await readFile(join(outside,"do-not-touch"),"utf8"),"important");
  } finally {
    await rm(outside,{recursive:true,force:true});
  }
});


test("opaque-top ternary fixture is pinned and remains source-only negative coverage", async () => {
  const {readFile} = await import("node:fs/promises");
  const {createHash} = await import("node:crypto");
  const content = await readFile(new URL(
    "../examples/unsupported-any-ternary.ores", import.meta.url));
  const gitSha = createHash("sha1")
    .update(Buffer.from("blob " + content.length + String.fromCharCode(0)))
    .update(content).digest("hex");
  assert.equal(gitSha, "e03fff33333ad9407b2d1151dc3a6355654349ed");
});

test("value-pipeline source fixture is byte-identical to shared conformance", async () => {
  const {readFile} = await import("node:fs/promises");
  const {createHash} = await import("node:crypto");
  const content = await readFile(new URL("../examples/value-pipe-scalar.ores", import.meta.url));
  const gitSha = createHash("sha1")
    .update(Buffer.from("blob " + content.length + String.fromCharCode(0)))
    .update(content).digest("hex");
  assert.equal(gitSha, "1ce089ef1592b2c263a44bb6a71067f5785c6f58");
  const invalid = await readFile(new URL("../examples/value-pipe-invalid.ores", import.meta.url));
  const invalidGitSha = createHash("sha1")
    .update(Buffer.from("blob " + invalid.length + String.fromCharCode(0)))
    .update(invalid).digest("hex");
  assert.equal(invalidGitSha, "7d0bb7f4984f22eb44d6d2c05c8008128aaed15a");
});
