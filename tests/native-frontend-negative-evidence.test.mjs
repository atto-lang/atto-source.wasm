// Native LLVM frontend-only rejection gate. It does NOT certify Wasm guest/AOT.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readBoundedRegularFile} from '../scripts/compile-ores.mjs';
import {NEGATIVE_FIXTURES as negative, POSITIVE_FIXTURE as positive,
  evaluateNativeNegativeReceipt} from '../scripts/verify-native-negative-receipt.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtures = new URL('./fixtures/boolean-v1/', import.meta.url);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const blobSha = bytes => createHash('sha1')
  .update(Buffer.from('blob ' + bytes.length + '\0', 'utf8'))
  .update(bytes).digest('hex');
const validSha = (s,n) => typeof s === 'string' &&
  s.length === n && /^[0-9a-f]+$/.test(s) && /[1-9a-f]/.test(s);

export function assertFrontendRejection(result, diagnostic) {
  if (!result || result.error || result.signal !== null ||
      result.status !== 1 || result.stdout !== '' ||
      typeof result.stderr !== 'string' ||
      !/^oreslang-llvmc:\s+\S.+/m.test(result.stderr) ||
      !result.stderr.includes(diagnostic)) {
    throw Error('NOT_EXECUTED: missing exact diagnosed native frontend rejection/no-IR proof');
  }
  return true;
}

export function requireCompilerIdentity(env) {
  if (!env.ORESLANG_LLVM_COMPILER || !isAbsolute(env.ORESLANG_LLVM_COMPILER) ||
      !validSha(env.ORESLANG_LLVM_COMPILER_SHA256,64) ||
      !validSha(env.ORESLANG_LLVM_SOURCE_SHA,40) ||
      !validSha(env.ORESLANG_LLVM_SOURCE_TREE,40) ||
      !validSha(env.ORESLANG_BOOL_WASM_EXPECTED_HEAD,40) ||
      (env.ATTO_NATIVE_NEGATIVE_RECEIPT_PATH &&
       (!validSha(env.ORESLANG_BOOL_WASM_SOURCE_TREE,40) ||
        !isAbsolute(env.ATTO_NATIVE_NEGATIVE_RECEIPT_PATH)))) {
    throw Error('NOT_EXECUTED: pinned native compiler, source tree and Wasm head required');
  }
  return env;
}

async function fixture(id, expectedBlob) {
  assert.match(id,/^[a-z][a-z0-9-]{1,50}$/);
  const {bytes} = await readBoundedRegularFile(
    fileURLToPath(new URL(id+'.atto', fixtures)),8192,
    'canonical .atto fixture must be bounded and non-symlinked');
  assert.ok(bytes.length > 20 && bytes.length < 8192);
  assert.equal(blobSha(bytes),expectedBlob,id+' original .atto fixture mutated');
  return bytes;
}

test('native negative corpus contains five distinct pinned .atto fixtures (SOURCE ONLY)', async () => {
  assert.equal(negative.length,5);
  assert.equal(new Set(negative.map(x=>x[0])).size,5);
  for (const [id,sha,diagnostic] of negative) {
    assert.match(sha,/^[0-9a-f]{40}$/);
    assert.ok(diagnostic.length > 20);
    await fixture(id,sha);
  }
  await fixture(...positive);
});
test('rejects forged frontend success, crash, emitted IR and unrelated parser errors (HOST ONLY)', () => {
  const expected = negative[0][2];
  const good = {status:1,signal:null,error:undefined,stdout:'',
    stderr:'oreslang-llvmc: '+expected+'\n'};
  assert.equal(assertFrontendRejection(good,expected),true);
  for (const changed of [
    {status:0},{status:2},{status:null},{signal:'SIGKILL'},
    {error:new Error('spawn')},{stdout:'define i64 @main() {}'},
    {stderr:'bridge rejected '+expected},
    {stderr:'oreslang-llvmc: unrelated compiler error'}
  ]) {
    assert.throws(()=>assertFrontendRejection({...good,...changed},expected),/NOT_EXECUTED/);
  }
});
test('missing, malformed or relative compiler evidence fails closed (HOST ONLY)', () => {
  assert.throws(()=>requireCompilerIdentity({}),/NOT_EXECUTED/);
  const good={ORESLANG_LLVM_COMPILER:'/opt/trusted/oreslang-llvmc',
    ORESLANG_LLVM_COMPILER_SHA256:'c'.repeat(64),
    ORESLANG_LLVM_SOURCE_SHA:'a'.repeat(40),
    ORESLANG_LLVM_SOURCE_TREE:'b'.repeat(40),
    ORESLANG_BOOL_WASM_EXPECTED_HEAD:'d'.repeat(40),
    ORESLANG_BOOL_WASM_SOURCE_TREE:'e'.repeat(40)};
  assert.equal(requireCompilerIdentity(good),good);
  for (const [key,value] of [
    ['ORESLANG_LLVM_COMPILER','./compiler'],
    ['ORESLANG_LLVM_COMPILER_SHA256','A'.repeat(64)],
    ['ORESLANG_LLVM_SOURCE_SHA','0'.repeat(40)],
    ['ORESLANG_LLVM_SOURCE_TREE','b'.repeat(39)],
    ['ORESLANG_BOOL_WASM_EXPECTED_HEAD','']
  ]) assert.throws(()=>requireCompilerIdentity({...good,[key]:value}),/NOT_EXECUTED/);
});

const demand = process.env.ATTO_NATIVE_NEGATIVE_REQUIRED ?? '0';
if (!['0','1'].includes(demand)) throw Error('ATTO_NATIVE_NEGATIVE_REQUIRED must be 0 or 1');
const required = demand === '1';
// Never let a compiler path alone turn ordinary PR/npm host checks into a
// credentialed compiler execution claim. The required integration step opts in.
test('five compiler-owned negative diagnostics, zero IR plus a positive LLVM IR control', {
  skip: !required,
  timeout: 180000
}, async () => {
  const env = requireCompilerIdentity(process.env);
  const {bytes:compilerBytes} = await readBoundedRegularFile(
    env.ORESLANG_LLVM_COMPILER, 256*1024*1024,
    'native LLVM compiler must be a bounded regular file');
  assert.equal(sha256(compilerBytes),env.ORESLANG_LLVM_COMPILER_SHA256,
    'executed compiler must match pinned source-binary digest');
  const checkout = spawnSync('git',['rev-parse','HEAD'],{
    cwd:root,encoding:'utf8',timeout:5000,maxBuffer:65536
  });
  assert.ifError(checkout.error);
  assert.equal(checkout.status,0);
  assert.equal(checkout.stdout.trim(),env.ORESLANG_BOOL_WASM_EXPECTED_HEAD,
    'Wasm checkout differs from expected exact head');
  const tree = spawnSync('git',['rev-parse','HEAD^{tree}'],{
    cwd:root,encoding:'utf8',timeout:5000,maxBuffer:65536
  });
  assert.ifError(tree.error);
  assert.equal(tree.status,0);
  if (env.ATTO_NATIVE_NEGATIVE_RECEIPT_PATH)
    assert.equal(tree.stdout.trim(),env.ORESLANG_BOOL_WASM_SOURCE_TREE,
      'Wasm tree differs from protected checkout evidence');
  const dir = await mkdtemp(join(tmpdir(),'atto-native-negative-'));
  try {
    // Execute an immutable copy of the pinned executable, never its mutable path.
    const compiler = join(dir,'pinned-compiler');
    await writeFile(compiler,compilerBytes,{flag:'wx',mode:0o500});
    const run = (path) => spawnSync(compiler,['--target=wasm32',path],{
      cwd:root,encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024,
      env:{PATH:process.env.PATH || '/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8'}
    });
    const goodPath = fileURLToPath(new URL(positive[0]+'.atto',fixtures));
    const goodSource = await fixture(...positive);
    const negativeReceipts=[];
    const good = run(goodPath);
    assert.ifError(good.error);
    assert.equal(good.signal,null);
    assert.equal(good.status,0,good.stderr);
    assert.match(good.stdout,/\bdefine\b/, 'positive source did not emit LLVM IR');
    assert.ok(good.stdout.length <= 4*1024*1024);
    assert.equal(blobSha((await readBoundedRegularFile(goodPath,8192)).bytes),positive[1]);
    assert.equal(blobSha(goodSource),positive[1]);
    for (const [id,sha,diagnostic] of negative) {
      const path = fileURLToPath(new URL(id+'.atto',fixtures));
      const input=await fixture(id,sha);
      const result=run(path);
      assertFrontendRejection(result,diagnostic);
      negativeReceipts.push(Object.freeze({
        id,sourceGitBlob:sha,sourceSha256:sha256(input),
        diagnostic,compilerExit:result.status,signal:result.signal,
        stdoutBytes:Buffer.byteLength(result.stdout),emittedIr:false,
        nativeCompiler:true,compilerSha256:env.ORESLANG_LLVM_COMPILER_SHA256,
        runAttempt:process.env.GITHUB_RUN_ATTEMPT||'',
        jobId:process.env.GITHUB_JOB||''
      }));
      assert.equal(blobSha((await readBoundedRegularFile(path,8192)).bytes),sha,
        'fixture mutated after compiler');
    }
    if (env.ATTO_NATIVE_NEGATIVE_RECEIPT_PATH) {
      const receipt={
        schema:'atto.native-negative.frontend/1',
        classification:'COMPILER_FRONTEND_ONLY',result:'EXECUTED',
        guestExecuted:false,guestAotCertified:false,hostOnly:false,
        wasmHead:checkout.stdout.trim(),wasmTree:tree.stdout.trim(),
        llvmHead:env.ORESLANG_LLVM_SOURCE_SHA,
        llvmTree:env.ORESLANG_LLVM_SOURCE_TREE,
        compilerSha256:env.ORESLANG_LLVM_COMPILER_SHA256,
        runId:process.env.GITHUB_RUN_ID||'',
        runAttempt:process.env.GITHUB_RUN_ATTEMPT||'',
        jobId:process.env.GITHUB_JOB||'',
        positive:{
          id:positive[0],sourceGitBlob:positive[1],
          sourceSha256:sha256(goodSource),llvmIrSha256:sha256(Buffer.from(good.stdout)),
          compilerExit:good.status,signal:good.signal,
          emittedIr:true,stdoutBytes:Buffer.byteLength(good.stdout),
          nativeCompiler:true
        },negatives:negativeReceipts
      };
      const evaluated=evaluateNativeNegativeReceipt(receipt,process.env);
      assert.equal(evaluated.classification,'LOCAL_NATIVE_FRONTEND_CASES_RECORDED',
        'protected source-local receipt context not satisfied');
      await writeFile(env.ATTO_NATIVE_NEGATIVE_RECEIPT_PATH,
        JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600});
    }
    console.log('COMPILER_OWNED_NEGATIVE_5=EXECUTED; WASM_GUEST=NOT_EXECUTED; AOT=NOT_CERTIFIED');
  } finally { await rm(dir,{recursive:true,force:true}); }
});
