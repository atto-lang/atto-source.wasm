import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile, readdir, lstat} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("../contracts/scalar/v1/", import.meta.url));

// A metadata/unit gate; this is NOT native LLVM-to-Wasm guest execution.
test("shared scalar corpus has exact inventory, signed i64 oracles and safe source files", async () => {
  const manifestBytes = await readFile(join(root,"cases.json"));
  const suite = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(suite.schema_version,"1.0.0");
  assert.equal(suite.cases.length,10);
  const hash = createHash("sha256").update(manifestBytes);
  const names = new Set();
  const ids = new Set();
  let positives = 0, negatives = 0;
  for (const entry of suite.cases) {
    assert.match(entry.id,/^[a-z][a-z0-9.-]{1,79}$/);
    assert(!ids.has(entry.id));
    ids.add(entry.id);
    assert.match(entry.file,/^fixtures\/[a-z0-9-]+\.ores$/);
    assert(!names.has(entry.file));
    names.add(entry.file);
    const path = join(root,entry.file);
    const st = await lstat(path);
    assert(st.isFile() && !st.isSymbolicLink());
    assert(st.size > 0 && st.size <= 1048576);
    const bytes = await readFile(path);
    assert(!bytes.includes(0));
    // Reject malformed UTF-8 even if it is inside a source comment.
    new TextDecoder("utf-8",{fatal:true}).decode(bytes);
    hash.update(Buffer.from(entry.file,"ascii")).update(Buffer.from([0])).update(bytes);
    if (entry.kind === "accept") {
      positives++;
      assert.match(entry.value,/^-?(?:0|[1-9][0-9]*)$/);
      const value = BigInt(entry.value);
      assert(value >= -(1n << 63n) && value < (1n << 63n));
    } else {
      assert.equal(entry.kind,"reject");
      assert(!Object.hasOwn(entry,"value"));
      negatives++;
    }
  }
  const disk = (await readdir(join(root,"fixtures"))).map(name=>"fixtures/"+name).sort();
  assert.deepEqual(disk,[...names].sort());
  assert.equal(positives,5);
  assert.equal(negatives,5);
  assert.equal(hash.digest("hex"),"4ca1512bbcab67d5af3f5db0665d139c802dd4cbbff048a3004c214d60bf3eb5");
});
