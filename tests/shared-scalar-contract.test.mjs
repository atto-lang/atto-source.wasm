import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile,lstat,readdir,mkdtemp,cp,rm,writeFile,appendFile,symlink} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {dirname,join} from "node:path";
import {tmpdir} from "node:os";

const root=join(dirname(fileURLToPath(import.meta.url)),"..","contracts","scalar","v1");
const expectedSuiteSha256="5b5d1bc00def9b3a343cb3281e0bb0be4e5ca438095f621141049e2d7a1a25b3";

async function verifyScalarCorpus(root){
  const fixtureDir=join(root,"fixtures");
  for(const dir of [root,fixtureDir]){
    const st=await lstat(dir);
    assert.ok(st.isDirectory()&&!st.isSymbolicLink(),"unsafe scalar corpus directory: "+dir);
  }
  const manifestPath=join(root,"cases.json");
  const manifestStat=await lstat(manifestPath);
  assert.ok(manifestStat.isFile()&&!manifestStat.isSymbolicLink()&&
    manifestStat.size>0&&manifestStat.size<=1048576,"unsafe scalar manifest");
  const manifestBytes=await readFile(manifestPath);
  const corpus=JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(corpus.schema_version,"1.0.0");
  assert.equal(corpus.cases.length,11);
  const hash=createHash("sha256").update(manifestBytes);
  const ids=new Set();
  const referencedFiles=new Set();
  let accepts=0,rejects=0;
  for(const c of corpus.cases){
    assert.match(c.id,/^[a-z][a-z0-9.-]{1,79}$/);
    assert.ok(!ids.has(c.id),"duplicate case id: "+c.id);
    ids.add(c.id);
    assert.match(c.file,/^fixtures\/[a-z0-9-]+\.ores$/);
    const fileName=c.file.slice("fixtures/".length);
    assert.ok(!referencedFiles.has(fileName),"duplicate scalar fixture: "+fileName);
    referencedFiles.add(fileName);
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
  const allFixtures=await readdir(fixtureDir,{withFileTypes:true});
  assert.deepEqual(allFixtures.map(entry=>entry.name).sort(),[...referencedFiles].sort(),
    "scalar fixture directory must exactly match reviewed manifest (no extras)");
  for(const entry of allFixtures){
    assert.ok(entry.isFile()&&!entry.isSymbolicLink(),
      "unsafe scalar fixture directory entry: "+entry.name);
  }
  assert.equal(accepts,6);
  assert.equal(rejects,5);
  assert.equal(hash.digest("hex"),expectedSuiteSha256,"scalar corpus SHA-256 drift");
}

test("shared scalar corpus bytes match .NET and JS parity contract",async()=>{
  await verifyScalarCorpus(root);
});

test("scalar corpus integrity detects adversarial filesystem mutations",async t=>{
  const mutations=[
    ["extra fixture",async dir=>{
      await writeFile(join(dir,"fixtures","unlisted.ores"),"pub fnc main(): int { return 0; }\n");
    },/scalar fixture directory must exactly match reviewed manifest/],
    ["modified fixture bytes",async dir=>{
      await appendFile(join(dir,"fixtures","literal-42.ores"),"\n");
    },/scalar corpus SHA-256 drift/],
    ["symlink fixture",async dir=>{
      const target=join(dir,"fixtures","precedence.ores");
      await rm(target);
      await symlink("literal-42.ores",target);
    },/unsafe scalar fixture/],
    ["symlink manifest",async dir=>{
      const manifest=join(dir,"cases.json");
      await cp(manifest,join(dir,"original-cases.json"));
      await rm(manifest);
      await symlink("original-cases.json",manifest);
    },/unsafe scalar manifest/],
    ["symlink fixture directory",async dir=>{
      const fixtures=join(dir,"fixtures");
      const moved=join(dir,"original-fixtures");
      await cp(fixtures,moved,{recursive:true});
      await rm(fixtures,{recursive:true});
      await symlink("original-fixtures",fixtures,"dir");
    },/unsafe scalar corpus directory/]
  ];
  for(const [name,mutate,diagnostic] of mutations){
    await t.test(name,async child=>{
      if(process.platform==="win32"&&name.startsWith("symlink")){
        child.skip("Windows symlink creation may require privileges");
        return;
      }
      const temp=await mkdtemp(join(tmpdir(),"ores-scalar-integrity-"));
      const candidate=join(temp,"v1");
      try {
        await cp(root,candidate,{recursive:true});
        await verifyScalarCorpus(candidate);
        await mutate(candidate);
        await assert.rejects(verifyScalarCorpus(candidate),diagnostic);
      } finally {
        await rm(temp,{recursive:true,force:true});
      }
    });
  }
});
