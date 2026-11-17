import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {rejectRawTerminalSourceControls} from '../scripts/source-terminal-control.mjs';
import {rejectUnsupportedDurableM0Source, compileOresToWasm}
  from '../scripts/compile-ores.mjs';
import {compileSourceActorToWasm} from '../scripts/compile-source-actor.mjs';

const safe = 'pub fnc main(): int { return 42; }';
const bytes = source => Buffer.from(source, 'utf8');

test('raw ESC/DEL and first NUL win at precise UTF-8 offsets', () => {
  for (const control of ['\x1b', '\x7f']) {
    for (const source of [
      '/* hidden' + control + ' */ ' + safe,
      '// hidden' + control + '\n' + safe,
      '"inside' + control + '"',
      '/* café 😀 */' + control + safe,
      'x\r\n' + control
    ]) {
      const at = Buffer.byteLength(source.slice(0, source.indexOf(control)), 'utf8');
      const expected = new RegExp('terminal control at byte offset ' + at + '$');
      assert.throws(() => rejectRawTerminalSourceControls(bytes(source)), expected);
      assert.throws(() => rejectUnsupportedDurableM0Source(bytes(source)), expected);
    }
  }
  assert.throws(() => rejectRawTerminalSourceControls(bytes('\0\x1b')),
    /contains NUL byte at byte offset 0$/);
  assert.throws(() => rejectRawTerminalSourceControls(bytes('\x7f\0')),
    /contains terminal control at byte offset 0$/);
});

test('visible escaped characters and valid UTF-8 remain source-admissible', () => {
  for (const source of ['/* café 😀 */ ' + safe, '\r\n\t', '"\\\\u001b"']) {
    assert.equal(rejectRawTerminalSourceControls(bytes(source)), source);
  }
  assert.throws(() => rejectRawTerminalSourceControls(new Uint8Array([0xff])),
    /encoded|utf/i);
  assert.throws(() => rejectRawTerminalSourceControls(new Uint8Array(1024*1024+1)),
    /byte budget exceeded/);
});

test('native byte admission rejects proxies without traps and accepts cross-realm views', () => {
  let calls = 0;
  const proxy = new Proxy(new Uint8Array([0x1b]), {
    get() { calls++; throw Error('proxy get trap'); },
    getPrototypeOf() { calls++; throw Error('proxy prototype trap'); }
  });
  assert.throws(() => rejectRawTerminalSourceControls(proxy),
    /genuine Uint8Array/);
  assert.equal(calls, 0);

  const foreign = runInNewContext('new Uint8Array([65, 66])');
  assert.equal(rejectRawTerminalSourceControls(foreign), 'AB');
  const shared = runInNewContext('new Uint8Array(new SharedArrayBuffer(2))');
  assert.throws(() => rejectRawTerminalSourceControls(shared), /shared backing/);

  const growable = new ArrayBuffer(4, {maxByteLength: 8});
  if (growable.resizable)
    assert.throws(() => rejectRawTerminalSourceControls(new Uint8Array(growable)),
      /fixed ArrayBuffer/);
});

test('both Wasm bridges refuse raw controls before invoking compiler', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ores-wasm-terminal-'));
  try {
    const compiler = join(dir, 'compiler');
    const source = join(dir, 'case.atto');
    const output = join(dir, 'out.wasm');
    const sentinel = join(dir, 'compiler-invoked.txt');
    await writeFile(compiler,
      '#!/bin/sh\nprintf ran > ' + JSON.stringify(sentinel) + '\nexit 1\n',
      {mode: 0o700});
    await writeFile(source, safe + ' // ' + String.fromCharCode(0x1b));
    await assert.rejects(() => compileOresToWasm({compiler, source, output}),
      /terminal control/);
    await assert.rejects(() => compileSourceActorToWasm({compiler, source}),
      /terminal control/);
    await assert.rejects(readFile(sentinel), {code: 'ENOENT'});
    await assert.rejects(readFile(output), {code: 'ENOENT'});
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
