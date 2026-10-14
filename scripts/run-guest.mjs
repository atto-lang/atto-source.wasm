import {readFile} from "node:fs/promises";
import {resolve, isAbsolute} from "node:path";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";

try {
  const options = new Map();
  for (const arg of process.argv.slice(2)) {
    const match = /^--(wasm|sha256|timeout-ms)=(.+)$/.exec(arg);
    if (!match || options.has(match[1])) throw Error("unexpected or duplicate option: " + arg);
    options.set(match[1], match[2]);
  }
  const path = options.get("wasm");
  if (!path || !isAbsolute(path)) throw Error("--wasm requires an absolute filename");
  const timeoutMs = options.has("timeout-ms") ? Number(options.get("timeout-ms")) : 2000;
  const wasm = await readFile(resolve(path));
  const {value, admission} = await runIsolatedCoreGuest(wasm, {
    expectedSha256: options.get("sha256"), timeoutMs
  });
  console.log(JSON.stringify({value: value.toString(), resultType: "i64", admission}, null, 2));
} catch (error) {
  console.error("Wasm guest rejected or failed: " + error.message);
  process.exitCode = 1;
}
