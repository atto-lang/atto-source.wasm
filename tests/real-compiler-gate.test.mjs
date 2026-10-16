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

test("nominal overload denial fixture uses equal-arity distinct enum declarations", async () => {
  const {readFile} = await import("node:fs/promises");
  const source = await readFile(
    new URL("../examples/nominal-overload-unsupported.ores", import.meta.url),
    "utf8"
  );
  assert.match(source, /define enum Color as\s+Red\s+end/);
  assert.match(source, /define enum Mode as\s+Fast\s+end/);
  assert.match(source, /fnc pick\(Color value\): int/);
  assert.match(source, /fnc pick\(Mode value\): int/);
  assert.match(source, /return pick\(Color\.Red\);/);
  // The live-pinned compiler/wasm artifact denial is separately required
  // by verify-real-compiler.mjs; a fixture shape check is not that proof.
});
