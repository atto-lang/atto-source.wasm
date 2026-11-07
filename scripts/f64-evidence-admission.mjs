// No source fetch or binary download. Accept only independently pinned,
// source-owned LLVM exact-head receipts; submitted SHA text alone proves nothing.
import {createHash} from "node:crypto";
import {readFile,lstat} from "node:fs/promises";
import {isAbsolute} from "node:path";
import {fileURLToPath} from "node:url";
import {readBoundedRegularFile} from "./compile-ores.mjs";

const sha256=b=>createHash("sha256").update(b).digest("hex");
const sha40=s=>typeof s==="string"&&/^[a-f0-9]{40}$/.test(s);
const sha64=s=>typeof s==="string"&&/^[a-f0-9]{64}$/.test(s);
const object=o=>o!==null&&typeof o==="object"&&!Array.isArray(o)&&
  (Object.getPrototypeOf(o)===Object.prototype||Object.getPrototypeOf(o)===null);
const tests=["native_f64_scalar_e2e","wasm_core_f64_entry_source_gate","native_float_ml"];
const originalFields=["schema","sourceRepository","sourceCommitSha","sourceRootTreeSha",
  "compilerBinarySha256","ctestJUnitSha256","executedTests","runnerName",
  "runId","runAttempt","execution","sourceToWasmWorker","javaParity","release"];
const guestFields=["schema","compilerSha256","sourceSha256","wasmSha256",
  "releaseSha256","profile","entry","value","hostImports","hostCapabilities",
  "negativeNoPublication","execution","certification"];

function fields(value,expected,where){
  if(!object(value)||JSON.stringify(Object.keys(value).sort())!==
      JSON.stringify([...expected].sort()))throw Error(where+" fields invalid");
}
export function assertApprovedLlvmF64Receipt(receipt,expected){
  fields(receipt,originalFields,"LLVM source receipt");
  if(!object(expected)||!sha40(expected.llvmSha)||!sha40(expected.llvmTree)||
      !sha64(expected.compilerSha256))throw Error("approval pins missing/invalid");
  if(receipt.schema!=="atto-llvm-f64-source-execution-v1"||
      receipt.sourceRepository!=="ores-truffle-oreslang/oreslang-source.llvm"||
      receipt.sourceCommitSha!==expected.llvmSha||
      receipt.sourceRootTreeSha!==expected.llvmTree||
      receipt.compilerBinarySha256!==expected.compilerSha256||
      !sha64(receipt.ctestJUnitSha256)||
      !Array.isArray(receipt.executedTests)||
      JSON.stringify([...receipt.executedTests].sort())!==JSON.stringify([...tests].sort())||
      typeof receipt.runnerName!=="string"||!receipt.runnerName.trim()||
      receipt.runnerName.length>128||
      !/^[1-9][0-9]*$/.test(receipt.runId||"")||
      !/^[1-9][0-9]*$/.test(receipt.runAttempt||"")||
      receipt.execution!=="EXECUTED"||
      receipt.sourceToWasmWorker!=="NOT_EXECUTED"||
      receipt.javaParity!=="NOT_CERTIFIED"||receipt.release!=="NOT_CERTIFIED")
    throw Error("LLVM source receipt is absent, stale, unexecuted or not the approved compiler");
  return true;
}
export function assertF64WorkerEvidence(guest,expectedCompilerSha){
  fields(guest,guestFields,"f64 Worker evidence");
  if(!sha64(expectedCompilerSha)||guest.schema!=="atto-f64-wasm-worker-v1"||
      guest.compilerSha256!==expectedCompilerSha||
      !sha64(guest.sourceSha256)||!sha64(guest.wasmSha256)||
      !sha64(guest.releaseSha256)||
      guest.profile!=="core-wasm.f64-v1"||guest.entry!=="main"||
      guest.value!==3.75||guest.hostImports!==0||
      guest.hostCapabilities!==0||guest.negativeNoPublication!==true||
      guest.execution!=="EXECUTED"||guest.certification!=="NOT_CERTIFIED")
    throw Error("real f64 Worker evidence missing or inconsistent");
  return true;
}
async function readPinnedFile(path,maxBytes,expectedSha){
  if(typeof path!=="string"||!isAbsolute(path)||!sha64(expectedSha))
    throw Error("absolute evidence path and independently approved SHA-256 required");
  const meta=await lstat(path);
  if(!meta.isFile()||meta.isSymbolicLink()||meta.size<1||meta.size>maxBytes)
    throw Error("evidence must be a bounded, regular, non-symlink file");
  const data=await readFile(path);
  if(data.byteLength!==meta.size||sha256(data)!==expectedSha)
    throw Error("approved source-owned evidence digest mismatch");
  return JSON.parse(data.toString("utf8"));
}
function approvalFromEnv(env){
  const pins={llvmSha:env.ORESLANG_LLVM_SOURCE_SHA,
    llvmTree:env.ORESLANG_LLVM_SOURCE_TREE,
    compilerSha256:env.ORESLANG_LLVM_COMPILER_SHA256};
  if(!sha40(pins.llvmSha)||!sha40(pins.llvmTree)||
      !sha64(pins.compilerSha256))
    throw Error("independently approved compiler/source pins required");
  return pins;
}
export async function verifyF64Approval(env=process.env){
  const expected=approvalFromEnv(env);
  const receipt=await readPinnedFile(env.ORESLANG_LLVM_RECEIPT_PATH,
    64*1024,env.ORESLANG_LLVM_RECEIPT_SHA256);
  assertApprovedLlvmF64Receipt(receipt,expected);
  if(!isAbsolute(env.ORESLANG_LLVM_COMPILER||""))
    throw Error("compiler must be a pre-provisioned absolute path");
  const binary=(await readBoundedRegularFile(env.ORESLANG_LLVM_COMPILER,
    256*1024*1024,"approved compiler executable oversized")).bytes;
  if(sha256(binary)!==expected.compilerSha256)
    throw Error("approved LLVM compiler executable SHA-256 mismatch");
  return {expected,receipt};
}
export async function finalizeF64Approval(env=process.env){
  const {expected,receipt}=await verifyF64Approval(env);
  const evidence=await readPinnedFile(env.ORESLANG_F64_GUEST_EVIDENCE_PATH,
    32*1024,env.ORESLANG_F64_GUEST_EVIDENCE_SHA256);
  assertF64WorkerEvidence(evidence,expected.compilerSha256);
  return {schema:"atto-f64-cross-backend-execution-v1",
    llvmSourceCommit:expected.llvmSha,llvmSourceTree:expected.llvmTree,
    llvmCompilerSha256:expected.compilerSha256,llvmSourceRunId:receipt.runId,
    wasmSourceCommit:env.ORESLANG_WASM_SOURCE_SHA,
    wasmSourceTree:env.ORESLANG_WASM_SOURCE_TREE,
    wasmSha256:evidence.wasmSha256,releaseSha256:evidence.releaseSha256,
    sourceTestCount:receipt.executedTests.length,
    realWasmGuestExecution:"EXECUTED",javaComparison:"NOT_EXECUTED",
    release:"NOT_CERTIFIED"};
}
const cli=process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1];
if(cli){
  verifyF64Approval().then(({expected,receipt})=>{
    console.log("LLVM_F64_APPROVED_SOURCE_RECEIPT="+receipt.runId);
    console.log("LLVM_F64_APPROVED_COMPILER_SHA256="+expected.compilerSha256);
  }).catch(e=>{console.error(e.message);process.exitCode=1});
}
