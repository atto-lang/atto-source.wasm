import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,symlink,open,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {readBoundedRegularFile} from "../scripts/compile-ores.mjs";

test("compiler input reader copies exact regular-file bytes with an inode record",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"ores-bounded-input-"));
 try{
  const path=join(dir,"source.ores");
  await writeFile(path,"pub fnc main(): int { return 42; }\n");
  const snapshot=await readBoundedRegularFile(path,1024,"source exceeds test limit");
  assert.equal(snapshot.bytes.toString("utf8"),"pub fnc main(): int { return 42; }\n");
  assert.equal(snapshot.stat.isFile(),true);
 }finally{await rm(dir,{recursive:true,force:true})}
});

test("compiler input reader refuses a symlink even to a valid small file",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"ores-bounded-input-"));
 try{
  const target=join(dir,"compiler"),link=join(dir,"compiler-link");
  await writeFile(target,"trusted");
  await symlink(target,link);
  await assert.rejects(readBoundedRegularFile(link,1024),/symlink|no-follow|ELOOP/);
 }finally{await rm(dir,{recursive:true,force:true})}
});

test("compiler input reader rejects a sparse over-budget file before allocating",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"ores-bounded-input-"));
 try{
  const path=join(dir,"oversized");
  const fd=await open(path,"wx");
  try{await fd.truncate(16*1024*1024+1)}
  finally{await fd.close()}
  await assert.rejects(
   readBoundedRegularFile(path,16*1024*1024,"input exceeds 16 MiB test budget"),
   /input exceeds 16 MiB test budget/
  );
 }finally{await rm(dir,{recursive:true,force:true})}
});

test("compiler input reader fails fast for a FIFO without blocking",{skip:process.platform!=="linux"},async()=>{
 const dir=await mkdtemp(join(tmpdir(),"ores-bounded-input-"));
 try{
  const fifo=join(dir,"pipe");
  const made=spawnSync("mkfifo",[fifo],{encoding:"utf8",timeout:10000});
  assert.equal(made.status,0,made.stderr||made.error?.message);
  await assert.rejects(readBoundedRegularFile(fifo,1024),/input exceeds byte budget|special|test budget|file|symlink/);
 }finally{await rm(dir,{recursive:true,force:true})}
});
