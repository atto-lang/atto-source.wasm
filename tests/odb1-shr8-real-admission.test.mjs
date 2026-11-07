import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {verifyOdb1ScalarWasm} from '../scripts/verify-odb1-shift8-real-wasm.mjs';

const file=fileURLToPath(new URL('../scripts/verify-odb1-shift8-real-wasm.mjs',import.meta.url));

test('required native ODB1 shift gate never silently skips a missing compiler',()=>{
  const env={...process.env};
  for(const k of ['ORESLANG_LLVM_COMPILER','ORESLANG_LLVM_COMPILER_SHA256',
                  'ORESLANG_LLVM_SOURCE_ROOT','ORESLANG_LLVM_SOURCE_SHA',
                  'ORESLANG_LLVM_SOURCE_TREE'])delete env[k];
  const run=spawnSync(process.execPath,[file],{
    env,encoding:'utf8',timeout:15000,maxBuffer:1024*1024
  });
  assert.equal(run.status,1,run.stderr);
  assert.match(run.stderr,/required ORESLANG_LLVM_COMPILER must be absolute/);
  assert.doesNotMatch(run.stdout,/REAL_COMPILER_PASS/);
});

test('malformed compiler pin is denied before execution',async()=>{
  await assert.rejects(verifyOdb1ScalarWasm({
    compiler:process.execPath,compilerSha256:'bad',sourceRoot:'/tmp',
    sourceCommit:'0'.repeat(40),sourceTree:'0'.repeat(40)
  }),/required ORESLANG_LLVM_COMPILER_SHA256/);
});

test('missing backend source tree never produces parity credit',async()=>{
  await assert.rejects(verifyOdb1ScalarWasm({
    compiler:process.execPath,compilerSha256:'0'.repeat(64),
    sourceRoot:'relative-not-allowed',sourceCommit:'0'.repeat(40),
    sourceTree:'0'.repeat(40)
  }),/required exact LLVM source root, commit and tree pins/);
});
