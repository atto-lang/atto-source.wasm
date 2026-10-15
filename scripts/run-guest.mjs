import {open} from "node:fs/promises";
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
  // Read with a hard budget; a path stat alone is susceptible to file growth.
  // SHA-256 pinning ensures admitted bytes match the expected artifact.
  const MAX_BYTES = 16 * 1024 * 1024;
  const file = await open(path, "r");
  let bytes;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 8 || info.size > MAX_BYTES) {
      throw Error("invalid or oversized guest Wasm file");
    }
    bytes = Buffer.allocUnsafe(info.size);
    let at = 0;
    while (at < bytes.length) {
      const {bytesRead} = await file.read(bytes, at, bytes.length - at, at);
      if (bytesRead === 0) throw Error("guest Wasm file changed or truncated while reading");
      at += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ino !== info.ino) {
      throw Error("guest Wasm file changed while reading");
    }
  } finally {
    await file.close();
  }
  const {value, admission} = await runIsolatedCoreGuest(bytes, {
    expectedSha256: pinnedSha256, timeoutMs
  });
  console.log(JSON.stringify({value: value.toString(), resultType: "i64", admission}, null, 2));
} catch (error) {
  console.error("Wasm guest rejected or failed: " + error.message);
  process.exitCode = 1;
}
