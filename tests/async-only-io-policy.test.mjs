import test from "node:test";
import assert from "node:assert/strict";
import {readdir, readFile} from "node:fs/promises";

const forbidden = [
  "readFileSync", "writeFileSync", "appendFileSync", "openSync(", "readSync(",
  "writeSync(", "execSync(", "execFileSync(", "spawnSync(", "Atomics.wait(",
  "XMLHttpRequest"
];

test("WASM guest runtime contains no blocking JS host I/O primitives", async () => {
  const root = new URL("../src/", import.meta.url);
  const files = (await readdir(root)).filter(name => name.endsWith(".mjs"));
  for (const name of files) {
    const source = await readFile(new URL(name, root), "utf8");
    for (const token of forbidden) {
      assert.equal(source.includes(token), false,
        "src/" + name + " contains forbidden blocking token " + token);
    }
  }
});

test("zero-capability profile keeps all guest host I/O imports denied", async () => {
  const source = await readFile(new URL("../src/guest-admission.mjs", import.meta.url), "utf8");
  assert.match(source, /imports\.length !== 0/);
  assert.match(source, /host imports denied/);
  assert.match(source, /ioMode !== "nio-only"/);
  assert.match(source, /guestNetworkIo !== false/);
});
