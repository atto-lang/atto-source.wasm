/**
 * Consumer-side verification of the *source-local* LLVM build receipt.
 *
 * Identifies the exact compiler bytes and clean Git source checkout. It is
 * NOT a signature, a trusted-build attestation or authorization to export
 * private source between repositories. Those are separate CI policy gates.
 */
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyPinnedLlvmCheckout} from './verify-pinned-llvm-checkout.mjs';

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SCHEMA = 'oreslang.llvm.compiler-receipt.v1';
// These pins select candidate compiler source; they do not authorize transfer.
export const REVIEWED_LLVM_SOURCE_SHA = 'a79156b74098c368763ee2c6843a65126e3051bf';
export const REVIEWED_LLVM_SOURCE_TREE = '43f8bda51bae2deb7747d73962be3ef6a3534628';
const MAX_COMPILER = 256 * 1024 * 1024;
const MAX_RECEIPT = 8192;

async function readRegularNoFollow(path, maximum, label) {
  if (typeof path !== 'string' || !isAbsolute(path))
    throw Error(label + ': absolute path required');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > maximum)
      throw Error(label + ': unsafe regular-file size');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!after.isFile() || bytes.length !== before.size ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw Error(label + ': file changed during verification');
    return {bytes, mode:before.mode};
  } finally {await handle.close();}
}

function canonicalLlvmReceipt({sourceCommit,sourceTree,compilerSha256}) {
  // Match the exact Python json.dump(sort_keys=True) producer format.
  // In particular, reject duplicate JSON keys and alternate encodings.
  return '{"compilerSha256": "' + compilerSha256 +
    '", "schema": "' + SCHEMA +
    '", "sourceCommit": "' + sourceCommit +
    '", "sourceTree": "' + sourceTree + '"}\n';
}

export async function verifyLlvmCompilerHandoff({
  compiler, compilerSha256, sourceDir, sourceSha, sourceTree, receipt,
  requireReviewedPin = false
} = {}) {
  if (typeof sourceSha !== 'string' || !SHA1.test(sourceSha) ||
      typeof sourceTree !== 'string' || !SHA1.test(sourceTree) ||
      typeof compilerSha256 !== 'string' || !SHA256.test(compilerSha256))
    throw Error('NOT_EXECUTED: exact LLVM source, tree and compiler digest pins required');
  if (requireReviewedPin && (sourceSha !== REVIEWED_LLVM_SOURCE_SHA ||
      sourceTree !== REVIEWED_LLVM_SOURCE_TREE))
    throw Error('NOT_EXECUTED: LLVM compiler source commit/tree is not the reviewed pin');
  if (typeof sourceDir !== 'string' || !isAbsolute(sourceDir) ||
      typeof compiler !== 'string' || !isAbsolute(compiler) ||
      typeof receipt !== 'string' || !isAbsolute(receipt))
    throw Error('NOT_EXECUTED: absolute LLVM source, compiler and receipt paths required');
  // The source-local build receipt is bound specifically to build/oreslang-llvmc.
  if (resolve(compiler) !== join(resolve(sourceDir), 'build', 'oreslang-llvmc'))
    throw Error('NOT_EXECUTED: compiler must be LLVM checkout build/oreslang-llvmc');
  const identity = verifyPinnedLlvmCheckout({sourceDir,sourceSha,sourceTree});
  const executable = await readRegularNoFollow(compiler,MAX_COMPILER,'compiler');
  if ((executable.mode & 0o111) === 0)
    throw Error('NOT_EXECUTED: LLVM compiler must be executable');
  const actualSha = createHash('sha256').update(executable.bytes).digest('hex');
  if (actualSha !== compilerSha256)
    throw Error('NOT_EXECUTED: compiler binary digest mismatch');
  const receiptBytes = await readRegularNoFollow(receipt,MAX_RECEIPT,'compiler receipt');
  if (receiptBytes.bytes.toString('utf8') !== canonicalLlvmReceipt({
    sourceCommit:identity.sourceSha,sourceTree:identity.sourceTree,
    compilerSha256:actualSha
  })) throw Error('NOT_EXECUTED: compiler receipt mismatch, malformed or duplicated fields');
  return Object.freeze({
    sourceSha:identity.sourceSha,
    sourceTree:identity.sourceTree,
    compilerSha256:actualSha,
    receiptMatched:true,
    trustedBuildAuthenticated:false,
    guestExecuted:false
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyLlvmCompilerHandoff({
      compiler:process.env.ORESLANG_LLVM_COMPILER,
      compilerSha256:process.env.ORESLANG_LLVM_COMPILER_SHA256,
      sourceDir:process.env.ORESLANG_LLVM_SOURCE_DIR,
      sourceSha:process.env.ORESLANG_LLVM_SOURCE_SHA,
      sourceTree:process.env.ORESLANG_LLVM_SOURCE_TREE,
      receipt:process.env.ORESLANG_LLVM_COMPILER_RECEIPT,
      requireReviewedPin:true
    });
    console.log('LLVM_COMPILER_HANDOFF_BYTES_VERIFIED ' +
      result.sourceSha + ' ' + result.sourceTree + ' ' + result.compilerSha256);
    console.log('STATUS: source/receipt identity only; trusted producer and guest execution independent');
  } catch (error) {
    console.error('NOT_EXECUTED: LLVM compiler handoff: ' + String(error?.message || error));
    process.exitCode = 1;
  }
}
