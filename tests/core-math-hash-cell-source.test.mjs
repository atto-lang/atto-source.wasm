import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile, lstat} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {assertScalarSourceHasNoImports} from "../scripts/compile-ores.mjs";

// Pure source snapshot gate, not a guest proof; no fallback on missing compiler.
const expected = Object.freeze({
  "math": "dc8c4f16f2b96639951cc63b5c92eb9ac4814db6",
  "hash": "85b6f087a1e7a1b7e775d9ee5c89734fcf5eb98f",
  "cell": "b7695151bf4a6521ea52301ef12eec73f8810c0f"
});
function gitBlob(bytes) {
  return createHash("sha1").update(Buffer.from("blob " + bytes.length + "\0"))
    .update(bytes).digest("hex");
}
function step(s, b) {
  if (!Number.isInteger(s) || s < 0 || s >= 1000000007 ||
      !Number.isInteger(b) || b < 0 || b > 255) return -1;
  let value=s*31+b;
  while (value>=1000000007) value-=1000000007;
  return value;
}
test("owned math/hash/cell sources are exact pinned regular .atto UTF-8", async () => {
  for (const [name, digest] of Object.entries(expected)) {
    const file=fileURLToPath(new URL("../library/atto.core/" + name + ".atto", import.meta.url));
    const stat=await lstat(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size>0 && stat.size<=1048576);
    const bytes=await readFile(file);
    assert.equal(gitBlob(bytes), digest, name + ": source drift");
    const source=new TextDecoder("utf-8", {fatal:true}).decode(bytes);
    assert.ok(!source.includes("\0") && !source.startsWith("\uFEFF"));
    assert.match(source,new RegExp("define module "+name+" as"));
    assert.doesNotMatch(source,/java:|dotnet:|import module .*std\//);
  }
});
test("portable noncryptographic octet-fold vectors", () => {
  for (const s of [0,1,17,569,1000000006])
    for (const octet of [0,1,42,127,255])
      assert.equal(step(s,octet),(s*31+octet)%1000000007);
  assert.equal(step(step(17,42),7),17646);
  assert.equal(step(-1,4),-1);
  assert.equal(step(17,256),-1);
});
test("Wasm scalar bridge rejects unfinished library graph instead of faking guest parity",async()=>{
  const guest=await readFile(new URL("../contracts/core-math-hash-cell-v1/guest.atto",import.meta.url));
  assert.throws(()=>assertScalarSourceHasNoImports(guest),/source imports require verified complete Wasm module graph/);
});
