import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtempSync,rmSync,writeFileSync,symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const cli = fileURLToPath(new URL("../scripts/run-guest.mjs",import.meta.url));
// Actual valid Wasm: one () -> i64 main returning 42, one private 1..2
// page memory exported as "memory", and no imports or start section.
const wasm = Buffer.from([
  0,97,115,109,1,0,0,0,1,5,1,96,0,1,126,3,2,1,0,
  5,4,1,1,1,2,
  7,17,2,4,109,97,105,110,0,0,6,109,101,109,111,114,121,2,0,
  10,6,1,4,0,66,42,11
]);
const pin=createHash("sha256").update(wasm).digest("hex");
function withTemp(callback){
  const dir=mkdtempSync(join(tmpdir(),"oreslang-cli-file-"));
  try{return callback(dir);}
  finally{rmSync(dir,{recursive:true,force:true});}
}
function run(path){
  return spawnSync(process.execPath,[cli,`--wasm=${path}`,`--sha256=${pin}`, "--timeout-ms=2500"],{
    encoding:"utf8",timeout:4000,maxBuffer:1024*1024,env:{...process.env}
  });
}
test("CLI accepts actual bounded regular Wasm with an independently pinned SHA",()=>{
  assert.equal(WebAssembly.validate(wasm),true);
  withTemp(dir=>{
    const path=join(dir,"guest.wasm");
    writeFileSync(path,wasm);
    const result=run(path);
    assert.equal(result.error,undefined,result.error?.message);
    assert.equal(result.status,0,result.stderr);
    const parsed=JSON.parse(result.stdout);
    assert.equal(parsed.value,"42");
    assert.equal(parsed.admission.sha256,pin);
  });
});
test("CLI refuses a symlink instead of following it", {skip:process.platform!=="linux"},()=>{
  withTemp(dir=>{
    const target=join(dir,"real.wasm"),link=join(dir,"alias.wasm");
    writeFileSync(target,wasm);
    symlinkSync(target,link);
    const result=run(link);
    assert.equal(result.error,undefined,result.error?.message);
    assert.notEqual(result.status,0,"symlink must not be admitted");
    assert.match(result.stderr,/symlink or special input file is forbidden/);
  });
});
test("CLI rejects an unwritten FIFO promptly instead of hanging before timeout",{skip:process.platform!=="linux"},()=>{
  withTemp(dir=>{
    const fifo=join(dir,"guest.fifo");
    const created=spawnSync("mkfifo",[fifo],{encoding:"utf8",timeout:4000});
    assert.equal(created.status,0,created.stderr);
    const result=run(fifo);
    assert.equal(result.error,undefined,"CLI must exit, not hit spawnSync timeout: "+result.error?.message);
    assert.notEqual(result.status,0,"FIFO must not be admitted");
    assert.match(result.stderr,/invalid or oversized guest Wasm file|special input file is forbidden/);
  });
});
test("CLI rejects directories and device-like non-regular files",{skip:process.platform!=="linux"},()=>{
  withTemp(dir=>{
    for(const path of [dir,"/dev/null"]){
      const result=run(path);
      assert.equal(result.error,undefined,result.error?.message);
      assert.notEqual(result.status,0);
      assert.match(result.stderr,/invalid or oversized guest Wasm file|special input file is forbidden/);
    }
  });
});
