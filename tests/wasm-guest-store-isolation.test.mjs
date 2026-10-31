// LLVM-generated Wasm guest execution without Cargo. This tests the guest
// counter and WebAssembly instance boundary, NOT Oreslang's native Wasmtime
// Store registry, AOT artifact trust, or OS tenant sandboxing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const COUNTER_IR = `target triple = "wasm32-unknown-unknown"
@counter = internal global i64 0, align 8
define i64 @main() {
entry:
  %old = load volatile i64, ptr @counter, align 8
  %next = add i64 %old, 1
  store volatile i64 %next, ptr @counter, align 8
  ret i64 %next
}
`;

test('compiled wasm32 counter isolates independent instances', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'oreslang-wasm-guest-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const ir = join(dir, 'tenant-counter.ll');
  const wasm = join(dir, 'tenant-counter.wasm');
  writeFileSync(ir, COUNTER_IR, {mode: 0o600});
  const result = spawnSync(process.env.CLANG || 'clang', [
    '--target=wasm32', '-x', 'ir', '-Oz', '-nostdlib',
    '-Wl,--no-entry', '-Wl,--export=main',
    '-Wl,--initial-memory=131072', '-Wl,--max-memory=131072',
    '-o', wasm, ir,
  ], {encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024});
  assert.equal(result.error, undefined, `clang did not execute: ${result.error}`);
  assert.equal(result.status, 0, `clang failed: ${result.stderr}`);
  const bytes = readFileSync(wasm);
  assert.ok(WebAssembly.validate(bytes), 'clang must emit valid core WebAssembly');
  const module = new WebAssembly.Module(bytes);

  await t.test('import-free module exposes only main and private memory', () => {
    assert.deepEqual(WebAssembly.Module.imports(module), []);
    assert.deepEqual(WebAssembly.Module.exports(module)
      .map(({name, kind}) => [name, kind]).sort(),
      [['main', 'function'], ['memory', 'memory']].sort());
  });

  const first = new WebAssembly.Instance(module);
  const second = new WebAssembly.Instance(module);
  await t.test('separate instance memory and interleaved state 1,1,2,2', () => {
    assert.notStrictEqual(first.exports.memory, second.exports.memory);
    assert.notStrictEqual(first.exports.memory.buffer, second.exports.memory.buffer);
    assert.deepEqual([
      first.exports.main(), second.exports.main(),
      first.exports.main(), second.exports.main(),
    ], [1n, 1n, 2n, 2n]);
  });
  await t.test('fresh incarnation resets without poisoning either neighbor', () => {
    const fresh = new WebAssembly.Instance(module);
    assert.equal(fresh.exports.main(), 1n);
    assert.equal(first.exports.main(), 3n);
    assert.equal(second.exports.main(), 3n);
  });
});
