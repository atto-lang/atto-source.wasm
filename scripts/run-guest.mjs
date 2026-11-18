import {readBoundedRegularFile} from "./compile-ores.mjs";
import {isAbsolute} from "node:path";
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
  const pinnedSha256 = options.get("sha256");
  if (!pinnedSha256 || !/^[a-f0-9]{64}$/.test(pinnedSha256)) {
    throw Error("--sha256=<64 lowercase hex digits> is required for executable admission");
  }
  // The CLI input path is not necessarily a regular file. Opening a FIFO
  // with ordinary O_RDONLY can block forever BEFORE the guest timeout begins.
  // Reuse the no-follow/nonblocking descriptor snapshot boundary used by the
  // compiler bridge; it also rejects symlinks, devices and in-flight changes.
  const MAX_BYTES = 16 * 1024 * 1024;
  const {bytes} = await readBoundedRegularFile(path, MAX_BYTES,
    "invalid or oversized guest Wasm file");
  if (bytes.length < 8) throw Error("invalid or oversized guest Wasm file");
  const {value, admission} = await runIsolatedCoreGuest(bytes, {
    expectedSha256: pinnedSha256, timeoutMs
  });
  console.log(JSON.stringify({value: value.toString(), resultType: "i64", admission}, null, 2));
} catch (error) {
  console.error("Wasm guest rejected or failed: " + error.message);
  process.exitCode = 1;
}
