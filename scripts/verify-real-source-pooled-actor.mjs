import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {verifyLlvmCompilerHandoff} from './verify-llvm-compiler-handoff.mjs';
if (!process.env.ORESLANG_LLVM_COMPILER ||
    !process.env.ORESLANG_LLVM_COMPILER.startsWith('/')) {
  console.error('NOT_EXECUTED: a real absolute-path ORESLANG_LLVM_COMPILER is required');
  process.exitCode = 1;
} else if (!/^[a-f0-9]{64}$/.test(process.env.ORESLANG_LLVM_COMPILER_SHA256 || '')) {
  console.error('NOT_EXECUTED: exact ORESLANG_LLVM_COMPILER_SHA256 pin is mandatory');
  process.exitCode = 1;
} else if (!/^[a-f0-9]{40}$/.test(process.env.ORESLANG_LLVM_SOURCE_SHA || '')) {
  console.error('NOT_EXECUTED: exact ORESLANG_LLVM_SOURCE_SHA pin is mandatory');
  process.exitCode = 1;
} else if (!/^[a-f0-9]{40}$/.test(process.env.ORESLANG_LLVM_SOURCE_TREE || '')) {
  console.error('NOT_EXECUTED: exact ORESLANG_LLVM_SOURCE_TREE pin is mandatory');
  process.exitCode = 1;
} else {
  try {
    await verifyLlvmCompilerHandoff({
      compiler: process.env.ORESLANG_LLVM_COMPILER,
      compilerSha256: process.env.ORESLANG_LLVM_COMPILER_SHA256,
      sourceDir: process.env.ORESLANG_LLVM_SOURCE_DIR,
      sourceSha: process.env.ORESLANG_LLVM_SOURCE_SHA,
      sourceTree: process.env.ORESLANG_LLVM_SOURCE_TREE,
      receipt: process.env.ORESLANG_LLVM_COMPILER_RECEIPT
    });
    const path = fileURLToPath(new URL('../tests/real-source-pooled-actor.test.mjs', import.meta.url));
    const r = spawnSync(process.execPath, ['--test', path], {
      stdio: 'inherit', timeout: 120000,
      env: {...process.env, REQUIRE_REAL_WASM_ACTOR: '1'}
    });
    process.exitCode = r.error || r.signal ? 1 : r.status;
  } catch (error) {
    console.error('NOT_EXECUTED: ' + String(error?.message || error));
    process.exitCode = 1;
  }
}
