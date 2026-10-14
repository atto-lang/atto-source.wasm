import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {runIsolatedCoreGuest} from '../src/isolated-runner.mjs';
import {admitCoreGuest} from '../src/guest-admission.mjs';

const scalarIr = 'target triple = "wasm32-unknown-unknown"\ndefine i64 @main() { ret i64 42 }\n';
const loopingIr = 'target triple = "wasm32-unknown-unknown"\ndefine i64 @main() { entry: br label %spin\nspin: br label %spin\n}\n';
function compile(ir) {
  const dir = mkdtempSync(join(tmpdir(), 'ores-wasm-audit-'));
  try {
    const out = join(dir, 'fixture.wasm');
    const r = spawnSync(process.env.CLANG || 'clang', [
      '--target=wasm32', '-x', 'ir', '-O0', '-nostdlib',
      '-Wl,--no-entry', '-Wl,--export=main',
      '-Wl,--initial-memory=131072', '-Wl,--max-memory=131072',
      '-o', out, '-'
    ], {input: ir, encoding: 'utf8', timeout: 30000});
    if (r.error || r.status !== 0) throw new Error('clang wasm32 failed: ' + (r.error?.message || r.stderr));
    return readFileSync(out);
  } finally { rmSync(dir, {recursive: true, force: true}); }
}

test('actual bounded scalar Wasm executes with pinned digest after worker termination', async () => {
  const bytes = compile(scalarIr);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const {value, admission} = await runIsolatedCoreGuest(bytes, {expectedSha256: hash});
  assert.equal(value, 42n);
  assert.equal(admission.sha256, hash);
  assert.equal(admission.imports, 0);
  assert.equal(admission.hostCapabilities, 0);
});
test('digest mismatch and malformed options reject instead of executing', async () => {
  const bytes = compile(scalarIr);
  await assert.rejects(runIsolatedCoreGuest(bytes, {expectedSha256: 'a'.repeat(64)}), /SHA-256 mismatch/);
  await assert.rejects(runIsolatedCoreGuest(bytes, {expectedSha256: 'not-a-hash'}), /invalid pinned SHA-256/);
  await assert.rejects(runIsolatedCoreGuest(bytes, {maxModuleBytes: Number.MAX_SAFE_INTEGER}), /invalid maximum module size/);
  await assert.rejects(runIsolatedCoreGuest(bytes, {maxMemoryPages: 0}), /invalid maximum memory pages/);
});
test('deadline terminates uncooperative Wasm and the next call can run', async () => {
  const loop = compile(loopingIr);
  await assert.rejects(runIsolatedCoreGuest(loop, {timeoutMs: 200}), /deadline exceeded/);
  assert.equal((await runIsolatedCoreGuest(compile(scalarIr))).value, 42n);
});
test('execution quota rejects a fifth live guest and is reclaimed after termination', async () => {
  const loop = compile(loopingIr);
  const running = Array.from({length: 4}, () =>
    runIsolatedCoreGuest(loop, {timeoutMs: 550}).then(() => false, error => /deadline exceeded/.test(error.message)));
  await assert.rejects(runIsolatedCoreGuest(compile(scalarIr)), /concurrency quota exceeded/);
  assert.deepEqual(await Promise.all(running), [true, true, true, true]);
  assert.equal((await runIsolatedCoreGuest(compile(scalarIr))).value, 42n);
});
test('pin mismatch is rejected before malformed Wasm gets parsed or compiled', () => {
  const malformed = Uint8Array.of(0, 1, 2);
  assert.throws(() => admitCoreGuest(malformed, {expectedSha256: '0'.repeat(64)}), /SHA-256 mismatch/);
  assert.throws(() => admitCoreGuest(malformed), /invalid core module header/);
});
test('oversized input is rejected before copying to the worker', async () => {
  await assert.rejects(runIsolatedCoreGuest(new Uint8Array(16 * 1024 * 1024 + 1)), /maximum byte size/);
  await assert.rejects(runIsolatedCoreGuest('bad'), /expected core WebAssembly bytes/);
});
