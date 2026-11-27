import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// Required-mode entrypoint: NEVER mark the compiler-dependent test as SKIP.
if (!process.env.ORESLANG_LLVM_COMPILER?.startsWith('/') ||
    !/^[a-f0-9]{64}$/.test(process.env.ORESLANG_LLVM_COMPILER_SHA256 || '')) {
  console.error('NOT_EXECUTED: independently authenticated real LLVM compiler and exact binary SHA-256 are required');
  process.exitCode = 1;
} else {
  const test = fileURLToPath(new URL('../tests/tenant-vm-real-source-actors.test.mjs', import.meta.url));
  const r = spawnSync(process.execPath, ['--test', test], {
    stdio: 'inherit', timeout: 180000,
    env: {...process.env, REQUIRE_REAL_TENANTVM_ACTOR: '1'}
  });
  process.exitCode = r.error || r.signal ? 1 : r.status;
}
