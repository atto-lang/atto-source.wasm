import test from "node:test";
import assert from "node:assert/strict";
import {compileOresToWasm, rejectUnsupportedSharedTcpPoolSource} from "../scripts/compile-ores.mjs";
import {mkdtemp,writeFile,chmod,access,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

const bytes = source => Buffer.from(source,"utf8");

test("Wasm source bridge refuses shared TCP pool before delegated LLVM invocation",()=>{
 for(const source of [
  "fnc main():int{return tcp.pool(config);}",
  "fnc main():int{return tcp /* a */ . pool(config);}",
  "fnc main():int{return pool.acquire_async(authority);}",
  "fnc main():int{return pool.open_stream_async(authority);}",
  "fnc main():int{return lease.exchange_async(payload);}"
 ])assert.throws(()=>rejectUnsupportedSharedTcpPoolSource(bytes(source)),
   /wasm guest TCP shared-pool lowering unsupported/);
});

test("Wasm TCP pool preflight does not mistake comments or strings for authority",()=>{
 for(const source of [
  "fnc main():int{return 42;} // tcp.pool(x)",
  "/* tcp.pool(x) /* pool.acquire_async(x) */ lease.exchange_async(x) */ fnc main():int{return 42;}",
  "fnc main():int{let s=\"tcp.pool(x)\";return 42;}",
  "fnc main():int{return 42;} // lease.exchange_async",
  "fnc main():int{return 42;}"
 ])assert.doesNotThrow(()=>rejectUnsupportedSharedTcpPoolSource(bytes(source)));
});

test("Wasm TCP pool scanner rejects malformed UTF-8",()=>{
 assert.throws(()=>rejectUnsupportedSharedTcpPoolSource(Uint8Array.of(0xc0,0xaf)),
   /encoded data was not valid/i);
});


test("source TCP lease denial occurs before any external compiler executes",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ores-wasm-pool-gate-"));
 const compiler=join(root,"sentinel-compiler");
 const source=join(root,"pooled.ores");
 const output=join(root,"pooled.wasm");
 const marker=join(root,"compiler-was-run");
 try{
  // Deliberately executable but unsafe sentinel: if the source gate is
  // accidentally moved after compiler dispatch, the marker exposes it.
  // This is a security-ordering test, not a guest compiler replacement.
  await writeFile(compiler,"#!/bin/sh\\nprintf 'RUN' > '"+marker+"'\\nexit 3\\n");
  await chmod(compiler,0o700);
  await writeFile(source,"fnc main():int{return tcp.pool(42);}");
  await assert.rejects(
    compileOresToWasm({compiler,source,output}),
    /wasm guest TCP shared-pool lowering unsupported/
  );
  await assert.rejects(access(marker),{code:"ENOENT"});
  await assert.rejects(access(output),{code:"ENOENT"});
 }finally{await rm(root,{recursive:true,force:true});}
});
