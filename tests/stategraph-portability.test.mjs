import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,rm,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {compileOresToWasm} from "../scripts/compile-ores.mjs";

// The bridge uses the real pinned Oreslang/LLVM compiler. These are actual
// .ores sources: do not implement a JavaScript fallback for graph semantics.
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const compiler=process.env.ORESLANG_LLVM_COMPILER;

async function withArtifact(t,name,fn){
  const temp=await mkdtemp(join(tmpdir(),"sg-wasm-native-"));
  t.after(()=>rm(temp,{recursive:true,force:true}));
  const source=join(root,"examples","stategraph-portability",name+".ores");
  assert.equal((await stat(source)).isFile(),true);
  const target=join(temp,"guest.wasm");
  return fn({source,target});
}

test("StateGraph scalar guest compiles and executes as real wasm i64",async t=>{
  if(!compiler){t.skip("NO_NATIVE_EVIDENCE: ORESLANG_LLVM_COMPILER missing");return;}
  await withArtifact(t,"scalar",async({source,target})=>{
    await compileOresToWasm({compiler:resolve(compiler),source,output:target});
    const bytes=await readFile(target);
    const {instance}=await WebAssembly.instantiate(bytes,{});
    assert.equal(typeof instance.exports.main,"function");
    assert.equal(instance.exports.main(),42n);
  });
});

for(const name of ["generic-state","actor-owned"]){
  test("StateGraph missing Wasm lowering fails closed: "+name,async t=>{
    if(!compiler){t.skip("NO_NATIVE_EVIDENCE: ORESLANG_LLVM_COMPILER missing");return;}
    await withArtifact(t,name,async({source,target})=>{
      await assert.rejects(()=>compileOresToWasm({
        compiler:resolve(compiler),source,output:target
      }),{message: /unsupported|rejected|failed|invalid|not implemented|compiler/i});
      await assert.rejects(()=>stat(target),{code:"ENOENT"});
    });
  });
}
