import test from "node:test";
import assert from "node:assert/strict";
import {compileOresToWasm} from "../scripts/compile-ores.mjs";
import {admitCoreGuest} from "../src/guest-admission.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";
const header=[0,97,115,109,1,0,0,0];
const type=[1,5,1,0x60,0,1,0x7e];
const memory=[5,4,1,1,1,2];
const code=[10,6,1,4,0,0x42,42,11];
function guest(moduleName, name) {
  const imported=moduleName!==undefined;
  const text=s=>[Buffer.byteLength(s),...Buffer.from(s)];
  const payload=imported?[1,...text(moduleName),...text(name),0,0]:[];
  return Uint8Array.from([...header,...type,...(imported?[2,payload.length,...payload]:[]),
    3,2,1,0,...memory,7,17,2,4,109,97,105,110,0,imported?1:0,
    6,109,101,109,111,114,121,2,0,...code]);
}
test("strict I/O metadata is mandatory without an option and guest still executes", async()=>{
  const bytes=guest();
  assert.equal(admitCoreGuest(bytes).coreIoPolicy,"native-async-only");
  const result=await runIsolatedCoreGuest(bytes);
  assert.equal(result.value,42n);
  assert.equal(result.admission.coreIoPolicy,"native-async-only");
});
test("public APIs refuse policy downgrades and host-injection options", async()=>{
  for(const options of [
    {coreIo:"legacy-blocking"},{coreIoPolicy:"off"},{allowBlockingIo:true},
    {imports:{}},{wasi:true},{workerIo:true},{coreIo:"native-async-only"},
    {unknownOption:1},Object.create({coreIo:"legacy-blocking"})
  ]){
    assert.throws(()=>admitCoreGuest(guest(),options),/options|option/);
    await assert.rejects(runIsolatedCoreGuest(guest(),options),/options|option/);
    await assert.rejects(compileOresToWasm(options),/options|option/);
  }
  let read=false;
  const options={get entry(){read=true; throw Error("must not invoke getter");}};
  assert.throws(()=>admitCoreGuest(guest(),options),/option/);
  await assert.rejects(runIsolatedCoreGuest(guest(),options),/option/);
  assert.equal(read,false);
});
test("real host imports cannot provide blocking, worker-backed or falsely async I/O",async()=>{
  for(const [moduleName,name] of [
    ["wasi_snapshot_preview1","fd_read"],["wasi_snapshot_preview1","fd_write"],
    ["wasi_snapshot_preview1","path_open"],["wasi_snapshot_preview1","sock_accept"],
    ["env","read_file_async"],["env","http_get_async"],["env","net_connect_async"],
    ["env","stdio_println"],["env","worker_io"],["wasi:io/poll","poll"]
  ]){
    const bytes=guest(moduleName,name);
    assert.equal(WebAssembly.validate(bytes),true,moduleName+"."+name);
    assert.throws(()=>admitCoreGuest(bytes),/host imports denied/);
    await assert.rejects(runIsolatedCoreGuest(bytes),/host imports denied/);
  }
});
