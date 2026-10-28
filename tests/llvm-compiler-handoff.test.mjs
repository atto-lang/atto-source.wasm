import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, readFile, chmod, symlink, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyLlvmCompilerHandoff as verify} from '../scripts/verify-llvm-compiler-handoff.mjs';

function git(dir,...args) {
  const r=spawnSync('git',['-C',dir,...args],{encoding:'utf8',timeout:10000});
  assert.equal(r.status,0,String(r.stderr || r.error));
  return r.stdout.trim();
}
async function fixture() {
  const tmp=await mkdtemp(join(tmpdir(),'ores-llvm-handoff-'));
  const sourceDir=join(tmp,'llvm');
  await mkdir(sourceDir);
  git(sourceDir,'init','-q');
  await writeFile(join(sourceDir,'main.cpp'),'int main() { return 42; }\n');
  git(sourceDir,'add','main.cpp');
  git(sourceDir,'-c','user.name=CI','-c','user.email=ci@example.invalid',
      'commit','-qm','compiler fixture');
  const sourceSha=git(sourceDir,'rev-parse','HEAD');
  const sourceTree=git(sourceDir,'rev-parse','HEAD^{tree}');
  await mkdir(join(sourceDir,'build'));
  const compiler=join(sourceDir,'build','oreslang-llvmc');
  await writeFile(compiler,'#!/bin/sh\nexit 0\n',{mode:0o755});
  await chmod(compiler,0o755);
  const compilerSha256=createHash('sha256').update(await readFile(compiler)).digest('hex');
  const receipt=join(tmp,'compiler-receipt.json');
  const goodReceipt=()=>JSON.stringify({
    compilerSha256,schema:'oreslang.llvm.compiler-receipt.v1',
    sourceCommit:sourceSha,sourceTree
  }).replaceAll(':', ': ').replaceAll(',', ', ')+'\n';
  await writeFile(receipt,goodReceipt(),{mode:0o600});
  return {tmp,sourceDir,sourceSha,sourceTree,compiler,compilerSha256,receipt,goodReceipt};
}
async function withFixture(fn) {
  const data=await fixture();
  try {await fn(data)} finally {await rm(data.tmp,{recursive:true,force:true})}
}
test('exact LLVM source, binary bytes and producer receipt match without claiming trusted build',async()=>{
  await withFixture(async d=>{
    const result=await verify(d);
    assert.equal(result.sourceSha,d.sourceSha);
    assert.equal(result.sourceTree,d.sourceTree);
    assert.equal(result.compilerSha256,d.compilerSha256);
    assert.equal(result.receiptMatched,true);
    assert.equal(result.trustedBuildAuthenticated,false);
    assert.equal(result.guestExecuted,false);
  });
});
test('missing provenance, wrong source tree or compiler digest are rejected',async()=>{
  await withFixture(async d=>{
    await assert.rejects(verify({...d,sourceTree:'a'.repeat(40)}),/commit\/tree mismatch/);
    await assert.rejects(verify({...d,sourceSha:'b'.repeat(40)}),/commit\/tree mismatch/);
    await assert.rejects(verify({...d,compilerSha256:'0'.repeat(64)}),/digest mismatch/);
    await assert.rejects(verify({...d,sourceTree:null}),/pins required/);
    await assert.rejects(verify({...d,receipt:null}),/absolute LLVM/);
  });
});
test('mutating tracked source or executable after receipt fails',async()=>{
  await withFixture(async d=>{
    await writeFile(join(d.sourceDir,'main.cpp'),'int main() { return 99; }\n');
    await assert.rejects(verify(d),/modified tracked files/);
    await writeFile(join(d.sourceDir,'main.cpp'),'int main() { return 42; }\n');
    await writeFile(d.compiler,'#!/bin/sh\nexit 99\n');
    await assert.rejects(verify(d),/digest mismatch/);
  });
});
test('altered schema, inflated proof, duplicate JSON keys and reused receipt all fail',async()=>{
  await withFixture(async d=>{
    await writeFile(d.receipt,d.goodReceipt().replace(
      'oreslang.llvm.compiler-receipt.v1','fake-receipt'));
    await assert.rejects(verify(d),/receipt mismatch/);
    await writeFile(d.receipt,d.goodReceipt().trimEnd().replace(/}$/,', "guestRuntimePass": true}')+'\n');
    await assert.rejects(verify(d),/receipt mismatch/);
    await writeFile(d.receipt,d.goodReceipt().replace(
      '"schema":','"schema": "duplicate", "schema":'));
    await assert.rejects(verify(d),/receipt mismatch/);
    await writeFile(d.receipt,d.goodReceipt());
    assert.equal((await verify(d)).receiptMatched,true);
  });
});
test('compiler must be the executable in-tree build product',async()=>{
  await withFixture(async d=>{
    await chmod(d.compiler,0o644);
    await assert.rejects(verify(d),/must be executable/);
    await chmod(d.compiler,0o755);
    const elsewhere=join(d.tmp,'some-compiler');
    await writeFile(elsewhere,'#!/bin/sh\nexit 0\n',{mode:0o755});
    await assert.rejects(verify({...d,compiler:elsewhere}),/build\/oreslang-llvmc/);
  });
});
test('compiler or receipt symlinks, oversized receipt, and missing receipt are rejected',async()=>{
  if(process.platform==='win32')return;
  await withFixture(async d=>{
    const alternate=join(d.tmp,'receipt-safe.json');
    await writeFile(alternate,d.goodReceipt());
    await rm(d.receipt);
    await symlink(alternate,d.receipt);
    await assert.rejects(verify(d));
    await rm(d.receipt);
    await writeFile(d.receipt,' '.repeat(8193));
    await assert.rejects(verify(d),/unsafe regular-file size/);
    await rm(d.receipt);
    await assert.rejects(verify(d));
    await writeFile(d.receipt,d.goodReceipt());
    const orig=join(d.sourceDir,'build','compiler-real');
    await writeFile(orig,'#!/bin/sh\nexit 0\n',{mode:0o755});
    await rm(d.compiler);
    await symlink(orig,d.compiler);
    await assert.rejects(verify(d));
  });
});
