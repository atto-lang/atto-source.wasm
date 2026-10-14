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
