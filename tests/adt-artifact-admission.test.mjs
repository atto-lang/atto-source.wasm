import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,access,readdir,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {compileOresToWasm} from "../scripts/compile-ores.mjs";

// This tests the executable publication boundary rather than only a lexer.
// The "compiler" deliberately writes a sentinel if accidentally executed.
const samples=[
 ["user enum","define enum Stage as Ready = 1 end\n"],
 ["typed Option","fnc main(Option<bool> x):int {return 0;}\n"],
 ["type pattern","define pattern Messages as Stage.Ready end\n"],
 ["qualified ADT match","match value over on Stage.Ready -> {return 7;} end\n"]
];
for(const [label,sourceText] of samples){
 test("Wasm ADT preflight prevents compiler execution and artifact publication: "+label,async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ores-wasm-adt-denial-"));
  try {
   const source=join(dir,"source.ores"),compiler=join(dir,"fake-compiler"),
    output=join(dir,"out.wasm"),sentinel=join(dir,"compiler-invoked");
   await writeFile(source,sourceText,{mode:0o600});
   await writeFile(compiler,"#!/bin/sh\nprintf invoked > \"$(dirname \"$0\")/compiler-invoked\"\nexit 0\n",{mode:0o700});
   await assert.rejects(
    ()=>compileOresToWasm({compiler,source,output}),
    /wasm .*ADT .*unsupported|wasm Option\/Result payload ADT lowering unsupported/i);
   for(const path of [sentinel,output,output+".provenance.json",output+".artifact.json"]){
    await assert.rejects(()=>access(path),{code:"ENOENT"});
   }
   assert.deepEqual((await readdir(dir)).sort(),["fake-compiler","source.ores"]);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}
