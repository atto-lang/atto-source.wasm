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
