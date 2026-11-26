import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  rejectSourceTerminalControls,
  rejectUnsupportedDurableM0Source,
} from '../scripts/compile-ores.mjs';

test('Wasm bridge blocks raw ESC/DEL even in comments before native compilation', () => {
  for (const control of [0x1b, 0x7f]) {
    const prefix = Buffer.from('pub fnc main():int{/*');
    const bytes = Buffer.concat([prefix, Buffer.from([control]), Buffer.from('*/return 42;}')]);
    assert.throws(() => rejectSourceTerminalControls(bytes), /SOURCE_TERMINAL_CONTROL/);
    assert.throws(() => rejectUnsupportedDurableM0Source(bytes), /SOURCE_TERMINAL_CONTROL/);
  }
});

test('normal whitespace passes terminal-control preflight', () => {
  const source = Buffer.from('pub fnc main():int{\r\n\treturn 42;\r\n}');
  assert.doesNotThrow(() => rejectSourceTerminalControls(source));
  assert.doesNotThrow(() => rejectUnsupportedDurableM0Source(source));
});

test('source preflight refuses non-byte inputs and oversize inputs', () => {
  assert.throws(() => rejectSourceTerminalControls('plain string'), TypeError);
  assert.throws(() => rejectSourceTerminalControls(Buffer.alloc(1024*1024+1)), RangeError);
  const safe=Buffer.from('fnc main():int{return 42;}');
  assert.doesNotThrow(() => rejectSourceTerminalControls(safe.buffer.slice(safe.byteOffset,safe.byteOffset+safe.byteLength)));
  assert.doesNotThrow(() => rejectSourceTerminalControls(new DataView(safe.buffer,safe.byteOffset,safe.byteLength)));
});

import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {compileOresToWasm} from '../scripts/compile-ores.mjs';
import {compileSourceActorToWasm} from '../scripts/compile-source-actor.mjs';
test('both bridges reject terminal controls before compiler invocation or publication', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'atto-terminal-'));
 try {
  const source=join(dir,'case.atto'),compiler=join(dir,'compiler'),output=join(dir,'case.wasm'),sentinel=join(dir,'called');
  await writeFile(compiler,'#!/bin/sh\necho invoked > '+JSON.stringify(sentinel)+'\nexit 1\n',{mode:0o700});
  await writeFile(source,'pub fnc main():int{return 42;} // '+String.fromCharCode(27));
  await assert.rejects(compileOresToWasm({compiler,source,output}),/SOURCE_TERMINAL_CONTROL/);
  await assert.rejects(compileSourceActorToWasm({compiler,source}),/SOURCE_TERMINAL_CONTROL/);
  await assert.rejects(readFile(sentinel),{code:'ENOENT'});
  await assert.rejects(readFile(output),{code:'ENOENT'});
 } finally {await rm(dir,{recursive:true,force:true});}
});
test('physical length cannot be spoofed; shared bytes rejected',()=>{
 class FakeLength extends Uint8Array {get byteLength(){return 0;}}
 assert.throws(()=>rejectSourceTerminalControls(new FakeLength([0x1b])),/SOURCE_TERMINAL_CONTROL/);
 assert.throws(()=>rejectSourceTerminalControls(new FakeLength(1024*1024+1)),RangeError);
 assert.throws(()=>rejectSourceTerminalControls(new Uint8Array(new SharedArrayBuffer(1))),TypeError);
});
