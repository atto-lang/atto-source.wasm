import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,stat,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {compileOresToWasm,rejectUnsupportedTildeAggregateSource} from "../scripts/compile-ores.mjs";

const bytes=source=>Buffer.from(source,"utf8");
const featureSources=[
 'fnc main():int{const m=~map<string,int>("x" => 42);return 42;}',
 'fnc main():int{const m=~map();return 42;}',
 'fnc main():int{const m=~<Map<string,int>>();return 42;}',
 'fnc main():int{const r=~record(foo:42);return 42;}',
 'fnc main():int{const r=~(foo:42);return 42;}',
 'fnc main():int{const r=~("foo" => 42);return 42;}',
 'fnc main():int{const r=~(compute_key() => 42);return 42;}',
 'fnc main():int{const r=~tuple(42,99);return 42;}',
 'fnc main():int{const r=~();return 42;}'
];
test("all unimplemented typed tilde aggregate syntaxes fail before LLVMc",()=>{
 for(const src of featureSources)
  assert.throws(()=>rejectUnsupportedTildeAggregateSource(bytes(src)),
   /WASM_TILDE_AGGREGATE_BACKEND_UNSUPPORTED:.*byte/,src);
});
test("source-only scanner ignores strings/comments and ordinary scalar unary/match",()=>{
 const safe=`fnc main():int{
  /* ~record(foo:42) and ~map<string,int>() */
  // ~("x" => 42)
  const msg="~map<string,int>(1 => 2)";
  return ~(x);
 }`;
 assert.doesNotThrow(()=>rejectUnsupportedTildeAggregateSource(bytes(safe)));
 assert.doesNotThrow(()=>rejectUnsupportedTildeAggregateSource(bytes(
  "fnc main():int{return match<int> 99 over default -> {42;} end;}"
 )));
});
test("actual bridge rejects unimplemented Map source before compiler or Wasm artifact",async()=>{
 const root=await mkdtemp(join(tmpdir(),"atto-wasm-tilde-"));
 try{
  const source=join(root,"guest.atto"),output=join(root,"guest.wasm");
  await writeFile(source,featureSources[0]);
  await assert.rejects(
   compileOresToWasm({compiler:"/bin/false",source,output}),
   /WASM_TILDE_AGGREGATE_BACKEND_UNSUPPORTED/);
  await assert.rejects(stat(output),{code:"ENOENT"});
 }finally{await rm(root,{recursive:true,force:true});}
});
