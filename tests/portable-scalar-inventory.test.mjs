// Source-inventory guard only: never credit this Node test as Oreslang guest execution.
import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile,readdir,lstat} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {join} from "node:path";

const root = fileURLToPath(new URL("./portable-scalar/",import.meta.url));
const expected = Object.freeze([
  ["32-grouping-multiplication","95a3f972fa6404bed6812397860c222b135d8202"],
  ["33-subtraction-precedence","c72b62d86dbb076f46bc16bbb265b8b19f15b08d"],
  ["34-unary-plus-digit-separator","34d8d32122c08a11c60f942f2c5edd6daeba97bc"],
  ["35-upper-bound-difference","d6a6e2f02d90a6bf111467970abb9390908f8fc9"],
  ["36-lower-bound-cancellation","a0ffb94b4fc1123c1d2721d2d8e79527b2295a74"],
  ["37-named-bitxor","855141b7ad25bdca471239cdfe4b5dcfd26b8ca2"]
]);

test("six reviewed .ores scalar source blobs are still byte-identical to canonical parity",async()=>{
  const manifest = await readFile(join(root,"oracles.tsv"),"utf8");
  assert.equal(manifest,expected.map(([name,blob])=>
    "tests/portable-scalar/"+name+".ores|42|"+blob+"\n").join(""));
  const files=(await readdir(root)).filter(name=>name.endsWith(".ores")).sort();
  assert.deepEqual(files,expected.map(([name])=>name+".ores").sort());
  for(const [name,expectedBlob] of expected){
    const file=join(root,name+".ores");
    const info=await lstat(file);
    assert.ok(info.isFile()&&!info.isSymbolicLink(),"symlinks/special sources forbidden");
    const bytes=await readFile(file);
    assert.ok(bytes.length>0&&bytes.length<=1048576,"bounded guest source required");
    const actual=createHash("sha1").update("blob "+bytes.length+"\0").update(bytes).digest("hex");
    assert.equal(actual,expectedBlob,"source blob mismatch for "+name);
  }
});
