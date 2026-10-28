// Mandatory real LLVM -> wasm32 signed remainder: no skipped-test success.
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {resolve} from "node:path";

const testPath = fileURLToPath(new URL("../tests/signed-remainder-source-parity.test.mjs", import.meta.url));
const expectedName =
  "pinned LLVM signed-literal remainder compiles and executes in a real isolated wasm32 guest";

export function assertRequiredSignedRemainderRun(result) {
  if (result?.error || result?.signal !== null || result?.status !== 0 ||
      typeof result?.stdout !== "string")
    throw Error("mandatory signed remainder execution failed or was interrupted");
  const output = result.stdout.replace(/\r\n/g, "\n");
  const count = key => {
    const matches = [...output.matchAll(new RegExp("^# " + key + " (\\d+)$", "gm"))];
    return matches.length === 1 ? Number(matches[0][1]) : null;
  };
  if (!output.includes("# Subtest: " + expectedName + "\n") ||
      count("tests") !== 1 || count("pass") !== 1 ||
      count("fail") !== 0 || count("cancelled") !== 0 ||
      count("skipped") !== 0 || count("todo") !== 0 ||
      /^not ok\b/m.test(output))
    throw Error("mandatory signed remainder TAP evidence missing or incomplete");
  return true;
}

export function executeRequiredSignedRemainder() {
  const env = {...process.env, ORESLANG_SIGNED_REMAINDER_REQUIRED:"1"};
  // Avoid nested Node tests silently skipping due to inherited worker context.
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, [
    "--test", "--test-reporter=tap", testPath
  ], {env, encoding:"utf8", timeout:240000, maxBuffer:4*1024*1024});
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return assertRequiredSignedRemainderRun(result);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { executeRequiredSignedRemainder(); }
  catch (error) {
    console.error("MANDATORY signed remainder gate FAILED: " +
      String(error?.message || error));
    process.exitCode = 1;
  }
}
