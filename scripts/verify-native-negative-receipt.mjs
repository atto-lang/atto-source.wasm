// SOURCE-LOCAL CONSISTENCY CHECK ONLY. Not an authenticated GitHub or guest AOT receipt.
// The only credentialed use is a manually dispatched, independently protected main.
import {constants, openSync, fstatSync, readSync, closeSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const NEGATIVE_FIXTURES = Object.freeze([
  Object.freeze(['bool-as-int', '0211a57f7f8108ca467ff76f3b8c9e6e834178aa',
    'native function return requires int, got bool']),
  Object.freeze(['truthy-int', '2f917d5683fc501c282e55bccec1d52a0b2118ba',
    'native guarded return condition requires bool, got int']),
  Object.freeze(['bool-arithmetic', '26c4cb3ca196f5d88ed756645138c75841e50e05',
    'arithmetic requires int, got bool']),
  Object.freeze(['comparison-type', '49d6d800fb043bdf06c224c8894ee997087b7ea5',
    'equality operands require the same scalar type']),
  Object.freeze(['not-integer', 'd3c8dd38ecf218f32b64df8acf785acdfe0309a4',
    "logical '!' requires bool, got int"])
]);
export const POSITIVE_FIXTURE = Object.freeze(
  ['literal-not', 'b241dc1838f88e55c1e54e1774d0863fba4c8011']);

const REPO = 'ores-truffle-oreslang/oreslang-source.wasm';
const SHA = /^[0-9a-f]+$/;
const sha = (v,n) => typeof v==='string' && v.length===n &&
  SHA.test(v) && /[1-9a-f]/.test(v);
const positiveInteger = v => Number.isSafeInteger(v) && v>0;
const object = v => v!==null && typeof v==='object' &&
  !Array.isArray(v) && Object.getPrototypeOf(v)===Object.prototype;
const reject = reason => Object.freeze({
  classification:'NOT_VERIFIED', reason, guestAotCertified:false,
  compilerExecutionCertified:false, exportAuthorized:false
});

export function evaluateNativeNegativeReceipt(receipt, context) {
  // Node's process.env is a host-backed object with a non-Object.prototype
  // prototype; unlike parsed receipts it must not be restricted to plain JSON.
  if (!object(receipt) || context===null || typeof context!=='object' ||
      Array.isArray(context))
    return reject('invalid receipt/context objects');
  if (context.GITHUB_ACTIONS!=='true' ||
      context.GITHUB_REF_PROTECTED!=='true' ||
      context.GITHUB_EVENT_NAME!=='workflow_dispatch' ||
      context.GITHUB_REPOSITORY!==REPO ||
      context.GITHUB_REF!=='refs/heads/main' ||
      context.GITHUB_JOB!=='integration')
    return reject('requires protected source-local manual integration job');
  if (!sha(context.GITHUB_SHA,40) ||
      context.GITHUB_SHA!==context.ORESLANG_BOOL_WASM_EXPECTED_HEAD ||
      !sha(context.ORESLANG_BOOL_WASM_SOURCE_TREE,40) ||
      !sha(context.ORESLANG_LLVM_SOURCE_SHA,40) ||
      !sha(context.ORESLANG_LLVM_SOURCE_TREE,40) ||
      !sha(context.ORESLANG_LLVM_COMPILER_SHA256,64) ||
      !/^[1-9][0-9]*$/.test(context.GITHUB_RUN_ID || '') ||
      !/^[1-9][0-9]*$/.test(context.GITHUB_RUN_ATTEMPT || ''))
    return reject('missing exact source/compiler identity or run binding');
  if (receipt.schema!=='atto.native-negative.frontend/1' ||
      receipt.classification!=='COMPILER_FRONTEND_ONLY' ||
      receipt.result!=='EXECUTED' ||
      receipt.guestExecuted!==false || receipt.guestAotCertified!==false ||
      receipt.hostOnly!==false)
    return reject('invalid evidence class or non-executed claim');
  for (const [key,expected] of [
    ['wasmHead',context.GITHUB_SHA],
    ['wasmTree',context.ORESLANG_BOOL_WASM_SOURCE_TREE],
    ['llvmHead',context.ORESLANG_LLVM_SOURCE_SHA],
    ['llvmTree',context.ORESLANG_LLVM_SOURCE_TREE],
    ['compilerSha256',context.ORESLANG_LLVM_COMPILER_SHA256],
    ['runId',context.GITHUB_RUN_ID],
    ['runAttempt',context.GITHUB_RUN_ATTEMPT],
    ['jobId',context.GITHUB_JOB]
  ]) if (receipt[key]!==expected)
    return reject('mismatched exact source/compiler/run/job binding: '+key);
  if (!object(receipt.positive) || !Array.isArray(receipt.negatives) ||
      receipt.negatives.length!==NEGATIVE_FIXTURES.length)
    return reject('missing positive control or incomplete native negatives');
  const p=receipt.positive;
  if (p.id!==POSITIVE_FIXTURE[0] || p.sourceGitBlob!==POSITIVE_FIXTURE[1] ||
      !sha(p.sourceSha256,64) || !sha(p.llvmIrSha256,64) ||
      p.compilerExit!==0 || p.signal!==null || p.emittedIr!==true ||
      !positiveInteger(p.stdoutBytes) || p.nativeCompiler!==true)
    return reject('positive native LLVM IR control absent');
  const seen = new Set([p.sourceGitBlob]);
  for (let i=0;i<NEGATIVE_FIXTURES.length;i++) {
    const [id,gitBlob,diagnostic]=NEGATIVE_FIXTURES[i];
    const c=receipt.negatives[i];
    if (!object(c) || c.id!==id || c.sourceGitBlob!==gitBlob ||
        seen.has(c.sourceGitBlob) || !sha(c.sourceSha256,64) ||
        c.diagnostic!==diagnostic || c.compilerExit!==1 ||
        c.signal!==null || c.stdoutBytes!==0 || c.emittedIr!==false ||
        c.nativeCompiler!==true || c.compilerSha256!==receipt.compilerSha256 ||
        c.runAttempt!==receipt.runAttempt || c.jobId!==receipt.jobId)
      return reject('missing, replayed, spliced, or non-native rejection case: '+id);
    seen.add(gitBlob);
  }
  // A local receipt can be fabricated; never represent this as authenticated
  // compiler/guest execution evidence even when every synthetic field matches.
  return Object.freeze({
    classification:'LOCAL_NATIVE_FRONTEND_CASES_RECORDED',
    caseCount:NEGATIVE_FIXTURES.length,
    positiveControlCount:1,
    compilerExecutionCertified:false,
    guestAotCertified:false,
    exportAuthorized:false
  });
}

export function readNativeNegativeReceipt(filename) {
  if (typeof filename!=='string' || !filename || filename.length>4096)
    throw Error('nonempty bounded receipt path required');
  if (!Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_NONBLOCK))
    throw Error('required nonblocking nofollow flags unavailable');
  const fd=openSync(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const stat=fstatSync(fd);
    if (!stat.isFile() || stat.size<1 || stat.size>65536)
      throw Error('receipt must be a nonempty regular file <=64 KiB');
    const bytes=Buffer.alloc(65537);
    let n=0;
    while (n<bytes.length) {
      const got=readSync(fd,bytes,n,bytes.length-n,null);
      if (got===0) break;
      n+=got;
    }
    if (n<1 || n>65536) throw Error('receipt length exceeded 64 KiB');
    return JSON.parse(bytes.toString('utf8',0,n));
  } finally {closeSync(fd);}
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length!==3) throw Error('usage: verify-native-negative-receipt.mjs <receipt.json>');
    const receipt=readNativeNegativeReceipt(process.argv[2]);
    const verdict=evaluateNativeNegativeReceipt(receipt,process.env);
    console.log(JSON.stringify(verdict));
    if (verdict.classification!=='LOCAL_NATIVE_FRONTEND_CASES_RECORDED')
      process.exitCode=1;
  } catch (error) {
    console.error(JSON.stringify(reject('invalid input: '+error.message)));
    process.exitCode=2;
  }
}
