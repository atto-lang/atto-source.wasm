import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {readBoundedRegularFile} from './compile-ores.mjs';

const compiler = process.env.ORESLANG_LLVM_COMPILER;
const pin = process.env.ORESLANG_LLVM_COMPILER_SHA256;
const failed = message => {console.error('NOT_EXECUTED: ' + message); process.exitCode = 1;};
if (!compiler || !compiler.startsWith('/') || !/^[a-f0-9]{64}$/.test(pin || '')) {
  failed('M2 requires real absolute LLVM compiler path and its exact SHA-256 pin');
} else {
  try {
    const binary = await readBoundedRegularFile(
      compiler, 256 * 1024 * 1024, 'compiler exceeds 256MiB budget');
    if (!binary.bytes.length || !(binary.stat.mode & 0o111))
      throw Error('compiler binary empty or non-executable');
    if (createHash('sha256').update(binary.bytes).digest('hex') !== pin)
      throw Error('compiler binary digest mismatch');
    const fixture = fileURLToPath(new URL(
      '../tests/fixtures/wasm32-actor-owned-scalar-frame.atto', import.meta.url));
    const source = (await readBoundedRegularFile(
      fixture, 1024 * 1024, 'M2 fixture oversized')).bytes;
    // Exact same Git blob as LLVM #1544. Never substitute an arbitrary source
    // fixture to make a test pass without checking its independently pinned ID.
    const gitBlobSha = createHash('sha1').update(
      Buffer.from('blob ' + source.length + '\0')).update(source).digest('hex');
    if (gitBlobSha !== 'c8d959234f3c04b7a8f14e0a4b6dc44aae5a3a1e')
      throw Error('canonical LLVM M2 .atto source blob changed');
    const file = fileURLToPath(new URL(
      '../tests/real-atto-pooled-actor-frame-m2.test.mjs', import.meta.url));
    const result = spawnSync(process.execPath,
      ['--test', '--test-reporter=tap', file], {
        encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024,
        env: {...process.env, REQUIRE_REAL_ATTO_WASM_FRAME: '1'}
      });
    const out = String(result.stdout || '');
    process.stdout.write(out);
    process.stderr.write(String(result.stderr || ''));
    const count = key => {
      const match = out.match(new RegExp('^# ' + key + ' ([0-9]+)$', 'm'));
      return match ? Number(match[1]) : -1;
    };
    const ok = !result.error && !result.signal && result.status === 0 &&
      count('tests') === 1 && count('pass') === 1 &&
      count('fail') === 0 && count('skipped') === 0 &&
      count('cancelled') === 0 && count('todo') === 0 &&
      out.includes('EXECUTED_ATTO_POOLED_FRAME_M2') &&
      out.includes('canonical .atto M2 frame compiles into real pooled Wasm guest');
    if (!ok) throw Error('exact M2 guest test inventory or execution failed (NOT_VERIFIED)');
    console.log('EXECUTED_ATTO_FRAME_M2=1; SKIPPED=0; ACTORS=8; WORKERS=2; VERIFIED_COMPILER_SHA256=' + pin);
  } catch (error) {
    failed(String(error?.message || error).slice(0, 350));
  }
}
