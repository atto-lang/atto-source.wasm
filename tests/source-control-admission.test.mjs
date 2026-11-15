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
