/**
 * Required REAL LLVM-Oreslang -> wasm32 -> core-Wasm scalar guest test.
 * Runs only the ODB1 signed >> 8 scalar prerequisite, NOT the WAL codec.
 * No host mock compiler, skipped backend, or hardcoded expected result counts.
 */
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {lstat, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {isAbsolute, join} from 'node:path';
import {compileOresToWasm, readBoundedRegularFile} from './compile-ores.mjs';
import {readAtomicRelease} from './atomic-release.mjs';
import {runIsolatedCoreGuest} from '../src/isolated-runner.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const hex40 = /^[0-9a-f]{40}$/;
const hex64 = /^[0-9a-f]{64}$/;

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding:'utf8', timeout:15000, maxBuffer:1024*1024
  });
  if (result.error || result.signal || result.status !== 0)
    throw Error('LLVM source Git provenance cannot be verified');
  return result.stdout.trim();
}

export async function verifyOdb1ScalarWasm({
  compiler=process.env.ORESLANG_LLVM_COMPILER,
  compilerSha256=process.env.ORESLANG_LLVM_COMPILER_SHA256,
  sourceRoot=process.env.ORESLANG_LLVM_SOURCE_ROOT,
  sourceCommit=process.env.ORESLANG_LLVM_SOURCE_SHA,
  sourceTree=process.env.ORESLANG_LLVM_SOURCE_TREE,
  clang=process.env.CLANG || 'clang'
}={}) {
  if (!compiler || !isAbsolute(compiler))
    throw Error('required ORESLANG_LLVM_COMPILER must be absolute');
  if (!hex64.test(compilerSha256 || ''))
    throw Error('required ORESLANG_LLVM_COMPILER_SHA256 must be a 64-hex pin');
  if (!sourceRoot || !isAbsolute(sourceRoot) ||
      !hex40.test(sourceCommit || '') || !hex40.test(sourceTree || ''))
    throw Error('required exact LLVM source root, commit and tree pins are missing');
  const actualRoot = git(sourceRoot, 'rev-parse', '--show-toplevel');
  if (actualRoot !== sourceRoot || git(sourceRoot, 'status', '--porcelain') !== '' ||
      git(sourceRoot, 'rev-parse', 'HEAD') !== sourceCommit ||
      git(sourceRoot, 'rev-parse', 'HEAD^{tree}') !== sourceTree)
    throw Error('LLVM compiler source checkout not exact or not clean');
  const {bytes:compilerBytes} = await readBoundedRegularFile(
    compiler, 256*1024*1024, 'untrusted LLVM compiler file'
  );
  if (sha256(compilerBytes) !== compilerSha256)
    throw Error('LLVM compiler binary SHA-256 mismatch');
  const scratch = await mkdtemp(join(tmpdir(), 'odb1-wasm-shr8-'));
  try {
    const positive = [
      ['zero','0>>8',0n],
      ['below-byte','255>>8',0n],
      ['first-high-byte','256>>8',1n],
      ['max-u16','65535>>8',255n],
      ['signed-id-max','2147483647>>8',8388607n],
      ['addition-first','255+1>>8',1n],
      ['chained','65536>>8>>8',1n],
      ['signed-negative','-256>>8',-1n]
    ];
    let executed = 0;
    for (const [name, expression, expected] of positive) {
      const source = join(scratch,name+'.ores');
      const output = join(scratch,name+'.wasm');
      const body = `pub fnc main():int{return ${expression};}\n`;
      await writeFile(source,body,{flag:'wx',mode:0o400});
      const result = await compileOresToWasm({
        compiler,compilerSha256,source,output,clang,
        environment:'browser',publication:'atomic'
      });
      const release = await readAtomicRelease(output);
      if (result.compilerSha256 !== compilerSha256 ||
          result.sourceSha256 !== sha256(Buffer.from(body)) ||
          result.wasmSha256 !== sha256(release.wasm) ||
          release.manifest?.wasmSha256 !== result.wasmSha256 ||
          release.manifest?.imports?.length !== 0)
        throw Error(`native wasm32 provenance mismatch in ${name}`);
      const executedGuest = await runIsolatedCoreGuest(release.wasm, {
        expectedSha256:result.wasmSha256, timeoutMs:5000
      });
      if (executedGuest.value !== expected ||
          executedGuest.admission.imports !== 0 ||
          executedGuest.admission.hostCapabilities !== 0)
        throw Error(`signed shift native wasm32 guest mismatch in ${name}`);
      executed++;
    }
    const negatives = ['256>>7','256>>8+1','256/256'];
    let rejected = 0;
    for (const [index, expression] of negatives.entries()) {
      const source = join(scratch,`reject-${index}.ores`);
      const output = join(scratch,`reject-${index}.wasm`);
      await writeFile(source,`pub fnc main():int{return ${expression};}\n`,
        {flag:'wx',mode:0o400});
      let denied = false;
      try {
        await compileOresToWasm({
          compiler,compilerSha256,source,output,clang,
          environment:'browser',publication:'atomic'
        });
      } catch (error) {
        if (!/native ODB1 scalar shift admits|native floating division unsupported/.test(
            String(error?.message || '')))
          throw Error('rejected source for unrelated compiler or tooling failure');
        denied = true;
      }
      if (!denied) throw Error(`invalid expression compiled: ${expression}`);
      for (const published of [output, output+'.current.json', output+'.provenance.json']) {
        try {
          await lstat(published);
        } catch (error) {
          if (error?.code === 'ENOENT') continue;
          throw error;
        }
        throw Error(`rejected scalar source published a Wasm artifact: ${expression}`);
      }
      rejected++;
    }
    // Final executable/source checkout consistency, not a full build attestation.
    const finalCompiler = await readBoundedRegularFile(
      compiler,256*1024*1024,'compiler modified after native wasm execution');
    if (sha256(finalCompiler.bytes) !== compilerSha256 ||
        git(sourceRoot,'status','--porcelain') !== '' ||
        git(sourceRoot,'rev-parse','HEAD') !== sourceCommit ||
        git(sourceRoot,'rev-parse','HEAD^{tree}') !== sourceTree)
      throw Error('LLVM compiler or source changed during wasm32 parity run');
    return {executed, rejected, compilerSha256, sourceCommit, sourceTree};
  } finally {
    await rm(scratch,{recursive:true,force:true});
  }
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const receipt = await verifyOdb1ScalarWasm();
    console.log('WASM_ODB1_SCALAR_SHR8_REAL_COMPILER_PASS '+
      `native_guest_cases=${receipt.executed} rejected=${receipt.rejected}; `+
      'NODE_WORKER_ONLY; NOT_WASMTIME; NOT_FULL_DB_CODEC');
  } catch (error) {
    console.error('ODB1_WASM_REAL_COMPILER_UNVERIFIED: '+String(error?.message || error));
    process.exitCode=1;
  }
}
