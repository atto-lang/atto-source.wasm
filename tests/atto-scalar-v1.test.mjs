import test from "node:test";
import assert from "node:assert/strict";
import {verifyAttoScalarV1,readPinnedAttoScalarSource} from "../scripts/atto-scalar-v1-inventory.mjs";
import {mkdtemp,mkdir,writeFile,symlink,rename,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
test("19 common .atto scalar programs are exact-byte pinned, not executed",async()=>{
 const cases=await verifyAttoScalarV1();
 assert.equal(cases.length,19);
 assert.equal(cases.filter(x=>x.kind==="positive").length,10);
 assert.equal(cases.filter(x=>x.kind==="negative").length,9);
 assert.equal(cases[0].bytes.toString("utf8"),"pub fnc main(): int { return 40 + 2; }\n");
});
test("source-only corpus is not a signed executable guest receipt",async()=>{
 const cases=await verifyAttoScalarV1();
 assert.ok(cases.every(c=>!Object.hasOwn(c,"wasmSha256")&&!Object.hasOwn(c,"executed")));
});

test("Atto scalar file reader denies traversal, oversized leaves and symlinked parents",async t=>{
 const temp=await mkdtemp(join(tmpdir(),"atto-wasm-pinned-fixture-"));
 t.after(()=>rm(temp,{recursive:true,force:true}));
 const parent=join(temp,"contracts","atto-scalar-v1");
 const dir=join(parent,"positive");
 const source=join(dir,"probe.atto");
 const relative="contracts/atto-scalar-v1/positive/probe.atto";
 await mkdir(dir,{recursive:true});
 await writeFile(source,"ok\n");
 assert.equal((await readPinnedAttoScalarSource(temp,relative)).toString("utf8"),"ok\n");
 await assert.rejects(()=>readPinnedAttoScalarSource(temp,"contracts/atto-scalar-v1/positive/../probe.atto"),/noncanonical/);
 await assert.rejects(()=>readPinnedAttoScalarSource(temp,"/etc/passwd"),/noncanonical/);
 await writeFile(source,"x".repeat(8193));
 await assert.rejects(()=>readPinnedAttoScalarSource(temp,relative),/byte budget/);
 await writeFile(source,"ok\n");
 await rename(dir,join(parent,"real-positive"));
 await symlink(join(parent,"real-positive"),dir,"dir");
 await assert.rejects(()=>readPinnedAttoScalarSource(temp,relative),/symlink/);
 await rm(dir);
 await rename(join(parent,"real-positive"),dir);
 await rename(source,source+".real");
 await symlink(source+".real",source,"file");
 await assert.rejects(()=>readPinnedAttoScalarSource(temp,relative),/symlink/);
});
