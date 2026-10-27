import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
const path = fileURLToPath(new URL("../scripts/verify-real-compiler.mjs",import.meta.url));
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

test("generator-v1 wasm32 gate requires compiler-owned capability diagnostic", async () => {
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
    ...diagnosed, stderr:"oreslang-llvmc: unexpected token"
  }), /required wasm32 compiler gate/);
  assert.throws(() => assertGeneratorV1WasmRejection({
    ...diagnosed, stdout:"define i32 @fake() { ret i32 0 }"
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
