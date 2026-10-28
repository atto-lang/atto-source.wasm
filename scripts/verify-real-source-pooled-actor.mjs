import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const executable = process.env.ORESLANG_LLVM_COMPILER;
const digest = process.env.ORESLANG_LLVM_COMPILER_SHA256;
if (!executable || !executable.startsWith('/')) {
  console.error('NOT_EXECUTED: a real absolute-path ORESLANG_LLVM_COMPILER is required');
  process.exitCode = 1;
} else if (!/^[a-f0-9]{64}$/.test(digest || '')) {
  console.error('NOT_EXECUTED: exact ORESLANG_LLVM_COMPILER_SHA256 pin is mandatory');
  process.exitCode = 1;
} else {
  const path = fileURLToPath(new URL('../tests/real-source-pooled-actor.test.mjs', import.meta.url));
  // A Node test process can exit zero even if every real guest test was marked
  // SKIP. Treat actual TAP inventory and pass/skip totals as part of the
  // acceptance receipt; do not promote a smoke-only test to guest parity.
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', path], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024,
    env: {...process.env, REQUIRE_REAL_WASM_ACTOR: '1'}
  });
  const stdout = String(r.stdout || ''), stderr = String(r.stderr || '');
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  const count = label => {
    const m = stdout.match(new RegExp('^# ' + label + ' ([0-9]+)$', 'm'));
    return m ? Number(m[1]) : -1;
  };
  const required = [
    'real .ores actor compiles through LLVM wasm32 and runs 1000 turns on two Workers',
    'actual LLVM frontend rejects source spawn and send with no output IR',
    'no executable proof is claimed without a real source compiler'
  ];
  const sawAllRequired = required.every(name =>
    stdout.split('\n').some(line => line.startsWith('ok ') && line.endsWith(' - ' + name)));
  const executed = !r.error && !r.signal && r.status === 0 &&
    count('tests') === 3 && count('pass') === 3 &&
    count('fail') === 0 && count('skipped') === 0 &&
    count('cancelled') === 0 && count('todo') === 0 &&
    sawAllRequired;
  if (!executed) {
    console.error('NOT_VERIFIED: real source-actor guest test inventory, zero-skip proof or execution failed');
    process.exitCode = 1;
  } else {
    console.log('REAL_POOLED_ACTOR_TESTS_VERIFIED=3; SKIPPED=0; WORKERS=2; ACTORS=40; TURNS=1000');
  }
}
