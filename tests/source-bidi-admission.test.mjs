import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {rejectBidirectionalSourceControls} from '../scripts/source-bidi-admission.mjs';
import {rejectUnsupportedDurableM0Source, compileOresToWasm} from '../scripts/compile-ores.mjs';
import {compileSourceActorToWasm} from '../scripts/compile-source-actor.mjs';

const SAFE = 'pub fnc main(): int { return 42; }';
const CONTROLS = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c,
  0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];

test('Wasm source preflight rejects all Trojan Source controls in comments', () => {
  for (const cp of CONTROLS) {
    for (const source of [SAFE + ' // ' + String.fromCodePoint(cp),
      '/* ' + String.fromCodePoint(cp) + ' */ ' + SAFE]) {
      const bytes = Buffer.from(source, 'utf8');
      assert.throws(() => rejectBidirectionalSourceControls(bytes),
        /bidirectional Unicode control/);
      assert.throws(() => rejectUnsupportedDurableM0Source(bytes),
        /bidirectional Unicode control/);
    }
  }
  assert.match(rejectBidirectionalSourceControls(Buffer.from('/* café */ ' + SAFE)),
    /pub fnc main/);
});

test('both Wasm bridges reject bidi source before running a compiler', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ores-wasm-bidi-'));
  try {
    const source = join(dir, 'case.atto');
    const compiler = join(dir, 'compiler');
    const sentinel = join(dir, 'compiled.txt');
    const output = join(dir, 'app.wasm');
    await writeFile(compiler, '#!/bin/sh\necho invoked > '+JSON.stringify(sentinel)+'\nexit 1\n', {mode:0o700});
    await writeFile(source, SAFE + ' // ' + String.fromCodePoint(0x202e));
    await assert.rejects(() => compileOresToWasm({compiler, source, output}),
      /bidirectional Unicode control/);
    await assert.rejects(() => compileSourceActorToWasm({compiler, source}),
      /bidirectional Unicode control/);
    await assert.rejects(readFile(sentinel), {code:'ENOENT'});
    await assert.rejects(readFile(output), {code:'ENOENT'});
  } finally {
    await rm(dir, {recursive:true, force:true});
  }
});

test('bidi scan uses native byte slots and rejects shared and invalid UTF-8',()=>{
 class FakeLength extends Uint8Array {get byteLength(){return 0;}}
 assert.throws(()=>rejectBidirectionalSourceControls(new FakeLength(Buffer.from('/* '+String.fromCodePoint(0x202e)+' */'))),/bidirectional Unicode control/);
 assert.throws(()=>rejectBidirectionalSourceControls(new FakeLength(1024*1024+1)),/maximum byte size/);
 assert.throws(()=>rejectBidirectionalSourceControls(new Uint8Array(new SharedArrayBuffer(1))),TypeError);
 assert.throws(()=>rejectBidirectionalSourceControls(Uint8Array.of(0xff)),TypeError);
});
