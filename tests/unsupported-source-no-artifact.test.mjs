import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,stat,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {compileOresToWasm} from "../scripts/compile-ores.mjs";

async function absent(path) {
 await assert.rejects(stat(path),{code:"ENOENT"});
}

test("source admission rejects unsupported declarations before compiler launch or artifact publication", async()=>{
 const root=await mkdtemp(join(tmpdir(),"ores-wasm-admission-"));
 const source=join(root,"input.ores");
 const compiler=join(root,"compiler-sentinel");
 const invoked=join(root,"compiler-was-invoked");
 const output=join(root,"artifact.wasm");
 try{
  // Deliberately non-Oreslang sentinel: the security claim is that the
  // preflight MUST reject before attempting to execute any compiler.
  // This does not substitute for a real compiler / LLVM-to-WASM test.
  await writeFile(compiler, '#!/bin/sh\nprintf invoked > "'+invoked+'"\nexit 97\n',
                  {mode:0o700});
  for(const [label,program,diagnostic] of [
   ["later tuple parameter",
    "fnc f(int a, tuple (int,int) b):int{return 1;}",/structural tuple v2/],
   ["later structural parameter",
    "fnc f(int a, structural Shape b):int{return 1;}",/structural tuple v2/],
   ["nested tuple generic",
    "fnc f(int a, Option<(int,int)> b):int{return 1;}",/structural tuple v2/],
   ["actor declaration after Unicode separator",
    "define\u0085actor Worker as end",/actor execution unsupported/],
   ["annotation after Unicode comment boundary",
    "// inert\u2028@Critical(1)\nfnc main():int{return 42;}",/annotation unsupported/],
   ["structural match declaration",
    "fnc main():int{match x over on structural Shape s -> {return 1;} end}",
    /structural pattern lowering unsupported/]
  ]){
   await writeFile(source,program);
   await assert.rejects(
    compileOresToWasm({compiler,source,output}),diagnostic,label);
   for(const pathname of [invoked,output,output+".artifact.json",
                          output+".provenance.json",output+".current.json",
                          output+".publication.lock"]){
    await absent(pathname);
   }
  }
 }finally{
  await rm(root,{recursive:true,force:true});
 }
});
