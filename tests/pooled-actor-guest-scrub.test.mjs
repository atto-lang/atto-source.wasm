import test from 'node:test';
import assert from 'node:assert/strict';
import {scrubFixedGuestMemory} from '../src/pooled-actor-guest-scrub.mjs';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';


const PAGE = 65536;

test('STOP physically scrubs the entire 2-page guest memory', () => {
  const memory = new WebAssembly.Memory({initial: 2, maximum: 2});
  const view = new Uint8Array(memory.buffer);
  view.fill(37);
  view[0] = 5; view[PAGE - 1] = 255; view[PAGE] = 99; view[2 * PAGE - 1] = 123;
  assert.equal(scrubFixedGuestMemory(memory), true);
  assert.equal(view.byteLength, 2 * PAGE);
  for (const byte of view) assert.equal(byte, 0);
});

test('native scrub survives monkeypatching the public Uint8Array.fill method', () => {
  const memory = new WebAssembly.Memory({initial: 2, maximum: 2});
  const before = Uint8Array.prototype.fill;
  new Uint8Array(memory.buffer).set([1,2,3,4], 64);
  try {
    Uint8Array.prototype.fill = function () {throw Error('tampered fill');};
    assert.equal(scrubFixedGuestMemory(memory), true);
    assert.deepEqual(Array.from(new Uint8Array(memory.buffer, 64, 4)), [0,0,0,0]);
  } finally {
    Uint8Array.prototype.fill = before;
  }
});

test('rejects wrong-size, forged, shared, or non-Wasm memory without ACK', () => {
  for (const pages of [1, 3]) {
    const memory = new WebAssembly.Memory({initial: pages, maximum: pages});
    assert.throws(() => scrubFixedGuestMemory(memory), /exactly two/);
  }
  assert.throws(() => scrubFixedGuestMemory({buffer:new ArrayBuffer(2*PAGE)}),
    /private guest Wasm memory/);
  assert.throws(() => scrubFixedGuestMemory(Object.create(WebAssembly.Memory.prototype)));
  if (typeof SharedArrayBuffer !== 'undefined') {
    const shared = new WebAssembly.Memory({initial: 2, maximum: 2, shared: true});
    assert.throws(() => scrubFixedGuestMemory(shared), /shared backing/);
  }
});

test('Clang-generated zero-import Wasm guest memory scrubs after lifecycle teardown', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'atto-actor-guest-scrub-'));
  const output = join(tmp, 'actor.wasm');
  const ir = [
    'target triple = "wasm32-unknown-unknown"',
    '@secret = internal global i64 0',
    'define void @oreslang_wasm_actor_init() { ret void }',
    'define i64 @oreslang_wasm_actor_on_message(i64 %value) {',
    'entry:',
    '  store i64 %value, ptr @secret',
    '  ret i64 %value',
    '}',
    'define void @oreslang_wasm_actor_teardown() { ret void }'
  ].join('\\n');
  try {
    const args = ['--target=wasm32', '-x', 'ir', '-O0', '-nostdlib',
      '-Wl,--no-entry', '-Wl,--export-memory',
      '-Wl,--export=oreslang_wasm_actor_init',
      '-Wl,--export=oreslang_wasm_actor_on_message',
      '-Wl,--export=oreslang_wasm_actor_teardown',
      '-Wl,--initial-memory=131072', '-Wl,--max-memory=131072',
      '-o', output, '-'];
    const built = spawnSync(process.env.CLANG || 'clang', args, {
      input: ir, encoding: 'utf8', timeout: 30000
    });
    if (built.error || built.status !== 0)
      throw Error('Clang wasm32 guest compile failed: ' + (built.error?.message || built.stderr));
    const wasm = readFileSync(output);
    const module = new WebAssembly.Module(wasm);
    assert.equal(WebAssembly.Module.imports(module).length, 0);
    const guest = new WebAssembly.Instance(module, {}).exports;
    assert.equal(guest.oreslang_wasm_actor_init(), undefined);
    assert.equal(guest.oreslang_wasm_actor_on_message(42n), 42n);
    const live = new Uint8Array(guest.memory.buffer);
    assert.equal(live.length, 131072);
    live.fill(0x6a);
    assert.equal(guest.oreslang_wasm_actor_teardown(), undefined);
    assert.equal(scrubFixedGuestMemory(guest.memory), true);
    assert.ok(live.every(b => b === 0), 'physical guest bytes remain zero');
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
});
