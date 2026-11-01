import test from "node:test";
import assert from "node:assert/strict";
import {rejectUnsupportedSharedTcpPoolSource} from "../scripts/compile-ores.mjs";

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
