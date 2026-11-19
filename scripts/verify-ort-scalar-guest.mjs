#!/usr/bin/env node
/**
 * Real LLVM -> Wasm32 -> isolated guest ORT scalar profile.
 * Explicit opt-in only: no mock compiler, no unpinned source, no source fetch.
 * Passing locally is NOT proof that GitHub Actions ran or that any other
 * Oreslang toolchain supports these constructs.
 */
import {createHash} from "node:crypto";
import {mkdir,mkdtemp,rm,realpath,lstat} from "node:fs/promises";
import {join,resolve,isAbsolute,dirname,sep} from "node:path";
import {tmpdir} from "node:os";
import {pathToFileURL} from "node:url";
import {compileOresToWasm,readBoundedRegularFile} from "./compile-ores.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";

export const REQUIRED=["option_present","option_absent","option_nested_absent",
  "result_success","result_error","trap_success","trap_nested",
  "trap_err_data","trap_cast_failure"];
const HEX40=/^[a-f0-9]{40}$/;
const HEX64=/^[a-f0-9]{64}$/;
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
const blob=bytes=>createHash("sha1")
  .update(Buffer.from("blob "+bytes.length+"\0")).update(bytes).digest("hex");
export function validateScalarInventory(manifest,lock){
  if(!manifest||manifest.schema!=="oreslang.option-result-trap.scalar/v3"||
     manifest.status!=="authored_not_executed"||
     JSON.stringify(manifest.backends)!==
       JSON.stringify(["java","llvm","wasm","cranelift","net"])||
     !Array.isArray(manifest.cases)||manifest.cases.length!==REQUIRED.length)
    throw Error("unknown or incomplete scalar fixture manifest");
  if(!lock||lock.schema!=="oreslang.option-result-trap.scalar-lock/v3"||
     !HEX40.test(lock.manifest_blob)||!Array.isArray(lock.cases)||
     lock.cases.length!==REQUIRED.length)
    throw Error("unknown or incomplete scalar fixture lock");
  const pins=new Map();
  for(const pin of lock.cases){
    if(!pin||!HEX40.test(pin.git_blob)||pins.has(pin.id)||
       Object.keys(pin).sort().join(",")!=="git_blob,id,path")
      throw Error("invalid or duplicate pinned scalar fixture");
    pins.set(pin.id,pin);
  }
  for(let i=0;i<REQUIRED.length;i++){
    const name=REQUIRED[i],c=manifest.cases[i],id="ORT3-"+name.toUpperCase(),
      path="fixtures/option-result-trap/v3/"+name+".ores",pin=pins.get(id);
    if(!c||c.id!==id||c.path!==path||c.kind!=="guest_i64"||
       c.expected_return!=="0"||c.return_type!=="int"||
       c.requires_guest_execution!==true||!pin||pin.path!==path)
      throw Error("scalar guest fixture or target ABI changed: "+id);
  }
}
function parseArgs(argv){
  const opts=new Map();
  for(const arg of argv){
    const found=/^--(compiler|compiler-sha256|clang|suite|source-commit)=(.+)$/.exec(arg);
    if(!found||opts.has(found[1]))throw Error("unexpected or duplicate option: "+arg);
    opts.set(found[1],found[2]);
  }
  for(const key of ["compiler","compiler-sha256","clang","suite","source-commit"])
    if(!opts.has(key))throw Error("missing required option --"+key);
  for(const key of ["compiler","clang","suite"])
    if(!isAbsolute(opts.get(key)))throw Error(key+" must be an absolute path");
  if(!HEX64.test(opts.get("compiler-sha256")))throw Error("invalid compiler digest");
  if(!HEX40.test(opts.get("source-commit")))throw Error("invalid source commit");
  return opts;
}
async function safeFixture(suite,relative){
  if(!/^fixtures\/option-result-trap\/v3\/[a-z_]+\.ores$/.test(relative))
    throw Error("invalid native scalar source path");
  const filename=resolve(suite,relative);
  if(!filename.startsWith(suite+sep))throw Error("fixture path escapes checkout");
  for(let parent=dirname(filename);parent!==suite;parent=dirname(parent)){
    const meta=await lstat(parent);
    if(!meta.isDirectory()||meta.isSymbolicLink())throw Error("linked fixture parent");
  }
  return (await readBoundedRegularFile(filename,131072)).bytes;
}
export async function runScalarSuite(opts){
  const suite=await realpath(opts.get("suite"));
  if(!(await lstat(suite)).isDirectory())throw Error("suite must be a directory");
  const base=join(suite,"fixtures/option-result-trap/v3");
  const manifestBytes=(await readBoundedRegularFile(join(base,"manifest.json"),131072)).bytes;
  const lockBytes=(await readBoundedRegularFile(join(base,"fixture-lock-v3.json"),131072)).bytes;
  const manifest=JSON.parse(manifestBytes.toString("utf8"));
  const lock=JSON.parse(lockBytes.toString("utf8"));
  validateScalarInventory(manifest,lock);
  if(blob(manifestBytes)!==lock.manifest_blob)
    throw Error("scalar manifest differs from reviewed Git blob");
  const compiler=opts.get("compiler");
  const compilerBytes=(await readBoundedRegularFile(compiler,256*1024*1024)).bytes;
  if(sha(compilerBytes)!==opts.get("compiler-sha256"))
    throw Error("compiler executable does not match supplied digest");
  const workspace=await mkdtemp(join(tmpdir(),"ores-ort3-wasm-"));
  const cases=[];
  try{
    for(const c of manifest.cases){
      const sourceBytes=await safeFixture(suite,c.path);
      const pin=lock.cases.find(x=>x.id===c.id);
      if(!pin||blob(sourceBytes)!==pin.git_blob)
        throw Error("guest source does not match reviewed Git blob: "+c.id);
      const output=join(workspace,c.id+".wasm");
      const record=await compileOresToWasm({
        compiler,compilerSha256:opts.get("compiler-sha256"),
        clang:opts.get("clang"),source:resolve(suite,c.path),
        output,exportName:"main",publication:"legacy"
      });
      if(record.sourceSha256!==sha(sourceBytes)||
         record.compilerSha256!==opts.get("compiler-sha256"))
        throw Error("compiler provenance mismatch: "+c.id);
      const wasm=(await readBoundedRegularFile(output,16*1024*1024)).bytes;
      if(sha(wasm)!==record.wasmSha256)
        throw Error("compiled Wasm bytes differ from compiler record: "+c.id);
      const {value}=await runIsolatedCoreGuest(wasm,{
        expectedSha256:record.wasmSha256,timeoutMs:3000
      });
      if(typeof value!=="bigint"||value.toString()!==c.expected_return)
        throw Error("actual native Oreslang Wasm guest return mismatch: "+c.id);
      cases.push({caseId:c.id,sourceSha256:sha(sourceBytes),
        wasmSha256:record.wasmSha256,guestReturn:value.toString()});
    }
  }finally{await rm(workspace,{recursive:true,force:true})}
  return {status:"LOCAL_REAL_GUEST_PASS_NOT_CI_ATTESTED",
    backend:"wasm",sourceCommitDeclared:opts.get("source-commit"),
    compilerSha256:opts.get("compiler-sha256"),cases};
}
const isCli=process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url;
if(isCli){
  try{
    const result=await runScalarSuite(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result,null,2));
  }catch(e){
    console.error("ORT native Wasm guest: "+(e instanceof Error?e.message:String(e)));
    process.exitCode=1;
  }
}
