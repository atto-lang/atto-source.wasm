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
function compile(ir, {maxMemory = true, allowUndefined = false, exports = []} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ores-wasm-audit-'));
  try {
    const out = join(dir, 'fixture.wasm');
    const args = ['--target=wasm32', '-x', 'ir', '-O0', '-nostdlib',
      '-Wl,--no-entry', '-Wl,--export=main', '-Wl,--initial-memory=131072'];
    if (maxMemory) args.push('-Wl,--max-memory=131072');
    if (allowUndefined) args.push('-Wl,--allow-undefined');
    for (const name of exports) args.push('-Wl,--export=' + name);
    args.push('-o', out, '-');
    const r = spawnSync(process.env.CLANG || 'clang', args, {input: ir, encoding: 'utf8', timeout: 30000});
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

test('worker admission rejects guest host imports before invocation', async () => {
  const ir = 'target triple = "wasm32-unknown-unknown"\ndeclare i64 @host_clock()\ndefine i64 @main() { %x = call i64 @host_clock()\n ret i64 %x }\n';
  const guest = compile(ir, {allowUndefined: true});
  await assert.rejects(runIsolatedCoreGuest(guest), /host imports denied/);
});
test('worker admission rejects unbounded guest memory', async () => {
  const guest = compile(scalarIr, {maxMemory: false});
  await assert.rejects(runIsolatedCoreGuest(guest), /memory requires fixed|bounded/);
});

test('guest worker refuses ambient parent environment while executing real Wasm', async () => {
  const key = 'ORESLANG_FORBIDDEN_HOST_ENV_SENTINEL';
  const previous = process.env[key];
  process.env[key] = 'do-not-inherit';
  try {
    const {value} = await runIsolatedCoreGuest(compile(scalarIr));
    assert.equal(value, 42n);
  } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
  }
});

test('compilation uses exact validated bytes once and keeps the metadata API opaque', async () => {
  const wasm = compile(scalarIr);
  const {compileAdmittedCoreGuest} = await import('../src/guest-admission.mjs');
  const {module, admission} = compileAdmittedCoreGuest(wasm);
  assert.ok(module instanceof WebAssembly.Module);
  assert.equal(admission.profile, 'core-wasm.i64-v1');
  assert.equal(admission.sha256, createHash('sha256').update(wasm).digest('hex'));
  assert.equal(Object.isFrozen(admission), true);
  assert.equal(Object.hasOwn(admitCoreGuest(wasm), 'module'), false);
});
test('reject wrong-arity guest main rather than relying on JavaScript coercion', async () => {
  const guest = compile('target triple = "wasm32-unknown-unknown"\ndefine i64 @main(i64 %n) { ret i64 %n }\n');
  await assert.rejects(runIsolatedCoreGuest(guest), /exact \(\) -> i64/);
});
test('reject unexpected function exports and start sections', async () => {
  const extra = compile('target triple = "wasm32-unknown-unknown"\ndefine i64 @main() { ret i64 42 }\ndefine i64 @other() { ret i64 9 }\n', {exports:['other']});
  await assert.rejects(runIsolatedCoreGuest(extra), /unexpected guest exports/);
  const started = Buffer.concat([compile(scalarIr), Buffer.from([8,1,0])]);
  await assert.rejects(runIsolatedCoreGuest(started), /start section/);
});
