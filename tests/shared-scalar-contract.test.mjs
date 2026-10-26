import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile,lstat} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {dirname,join} from "node:path";

const root=join(dirname(fileURLToPath(import.meta.url)),"..","contracts","scalar","v1");
const expectedSuiteSha256="5b5d1bc00def9b3a343cb3281e0bb0be4e5ca438095f621141049e2d7a1a25b3";

test("shared scalar corpus bytes match .NET and JS parity contract",async()=>{
  const manifestBytes=await readFile(join(root,"cases.json"));
  const corpus=JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(corpus.schema_version,"1.0.0");
  assert.equal(corpus.cases.length,11);
  const hash=createHash("sha256").update(manifestBytes);
  const ids=new Set();
  let accepts=0,rejects=0;
  for(const c of corpus.cases){
    assert.match(c.id,/^[a-z][a-z0-9.-]{1,79}$/);
    assert.ok(!ids.has(c.id),"duplicate case id: "+c.id);
    ids.add(c.id);
    assert.match(c.file,/^fixtures\/[a-z0-9-]+\.ores$/);
    const path=join(root,c.file);
    const st=await lstat(path);
    assert.ok(st.isFile()&&!st.isSymbolicLink()&&st.size>0&&st.size<=1048576,
      "unsafe scalar fixture: "+c.file);
    const bytes=await readFile(path);
    hash.update(Buffer.from(c.file,"ascii"));
    hash.update(Buffer.from([0]));
    hash.update(bytes);
    if(c.kind==="accept")accepts++;
    else if(c.kind==="reject")rejects++;
    else assert.fail("unknown scalar case kind: "+c.kind);
  }
  assert.equal(accepts,6);
  assert.equal(rejects,5);
  assert.equal(hash.digest("hex"),expectedSuiteSha256);
});
