import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp,readFile,writeFile,rm,readdir} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {compileOresToWasm} from "../scripts/compile-ores.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";
const raw=await readFile(new URL("./mandatory-async-io.json",import.meta.url));
const corpus=JSON.parse(raw);
test("shared strict I/O fixture identity cannot drift",()=>{
 assert.equal(createHash("sha256").update(raw).digest("hex"),"e3b5caa3267683e7a1ec83f04d671333455746ceb87188dba6ec7ec1e75ec042");
 assert.equal(corpus.cases.length,22);
});
test("real Oreslang-to-Wasm compiler refuses guest I/O before artifact publication",{skip:!process.env.ORESLANG_LLVM_COMPILER,timeout:60000},async()=>{
 const compiler=process.env.ORESLANG_LLVM_COMPILER;
 const compilerSha256=createHash("sha256").update(await readFile(compiler)).digest("hex");
 const directory=await mkdtemp(join(tmpdir(),"ores-mandatory-async-wasm-"));
 try{
  const source=join(directory,"main.ores");const output=join(directory,"main.wasm");
  let previous,entries;
  for(const item of corpus.cases){
   await writeFile(source,item.source);
   if(item.expect==="accept"){
    await compileOresToWasm({compiler,compilerSha256,source,output});
    previous=await readFile(output);entries=(await readdir(directory)).sort();
    assert.equal((await runIsolatedCoreGuest(previous)).value,42n);
   }else{
    await assert.rejects(compileOresToWasm({compiler,compilerSha256,source,output}),
      error=>/command failed/.test(error.message)&&/oreslang-llvmc:/.test(error.message),item.id);
    assert.deepEqual(await readFile(output),previous,item.id+": changed executable");
    assert.deepEqual((await readdir(directory)).sort(),entries,item.id+": partial artifact");
   }
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});
