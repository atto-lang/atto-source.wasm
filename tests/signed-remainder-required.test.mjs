import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {assertRequiredSignedRemainderRun} from "../scripts/require-signed-remainder.mjs";

const name = "pinned LLVM signed-literal remainder compiles and executes in a real isolated wasm32 guest";
const receipt = () => "TAP version 13\n# Subtest: " + name +
  "\nok 1 - " + name + "\n1..1\n# tests 1\n# pass 1\n# fail 0\n" +
  "# cancelled 0\n# skipped 0\n# todo 0\n";
const completed = stdout => ({status:0,signal:null,error:undefined,stdout});

test("mandatory signed-remainder TAP must prove an executed, unskipped test", () => {
  assert.equal(assertRequiredSignedRemainderRun(completed(receipt())),true);
  for (const bad of [
    completed(receipt().replace("# skipped 0","# skipped 1")),
    completed(receipt().replace("# pass 1","# pass 0")),
    completed(receipt().replace("# tests 1","# tests 0")),
    completed(receipt().replace("# cancelled 0","# cancelled 1")),
    completed(receipt().replace("# todo 0","# todo 1")),
    completed(receipt().replace("# fail 0","# fail 1")),
    completed(receipt().replace("# Subtest: " + name,"# Subtest: fake")),
    completed(receipt() + "# tests 1\n"),
    completed(receipt() + "not ok 2 - fake\n"),
    {...completed(receipt()),status:1},
    {...completed(receipt()),signal:"SIGKILL"},
    {...completed(receipt()),error:new Error("ENOENT")},
    {status:0,signal:null,stdout:""}
  ]) assert.throws(() => assertRequiredSignedRemainderRun(bad),
    /mandatory signed remainder/);
});

test("mandatory signed-remainder CLI fails closed without real compiler", () => {
  const env={...process.env};
  for (const key of ["ORESLANG_LLVM_COMPILER","ORESLANG_LLVM_COMPILER_SHA256",
                     "ORESLANG_LLVM_SOURCE_SHA","NODE_TEST_CONTEXT","NODE_OPTIONS"]) delete env[key];
  const script=fileURLToPath(new URL("../scripts/require-signed-remainder.mjs",import.meta.url));
  const result=spawnSync(process.execPath,[script],
    {env,encoding:"utf8",timeout:15000,maxBuffer:1024*1024});
  assert.equal(result.error,undefined);
  assert.equal(result.signal,null);
  assert.equal(result.status,1);
  assert.match(result.stderr,/MANDATORY signed remainder gate FAILED/);
  assert.doesNotMatch(result.stdout,/# pass 1\s*$/m);
});
