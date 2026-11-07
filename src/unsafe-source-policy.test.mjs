import test from 'node:test';
import assert from 'node:assert/strict';
import {rejectUnsupportedUnsafeSource as reject} from './unsafe-source-policy.mjs';
const bytes = s => Buffer.from(s, 'utf8');
const invalid = [
  'unsafe fnc main():int{return 42;}',
  'fnc main():int { unsafe { return 42; } }',
  'fnc unsafe():int{return 42;}',
  'fnc main():int{return std.unsafe.memory.read();}',
  'fnc main():int{return `prefix ${unsafe}`;}',
  'fnc main():int{return `outer ${`inner ${unsafe}`}`;}',
];
const harmless = [
  'fnc main():int{return 42;} // unsafe',
  'fnc main():int{return 42;} /* unsafe /* unsafe */ */',
  'fnc unsafe_helper():int{return 42;}',
  'fnc main():string{return "unsafe";}',
  'fnc main():string{return `unsafe`;} ',
  'fnc main():Symbol{return #unsafe;}',
  'fnc main():string{return `outer ${"unsafe"} suffix`;} ',
];
test('Wasm bridge rejects actual unsafe source lexemes, including nested templates', () => {
  for (const source of invalid) {
    assert.throws(() => reject(bytes(source)), /wasm unsafe boundary unsupported: effects and native grants unavailable at byte [0-9]+/);
  }
});
test('CR, CRLF and LF comments cannot mask a later unsafe token', () => {
  for (const newline of ['\r', '\r\n', '\n', '\u0085', '\u2028', '\u2029']) {
    const source = 'fnc main():int{return 42;} // ignored' + newline + 'unsafe';
    const at = Buffer.byteLength(source.slice(0, source.lastIndexOf('unsafe')), 'utf8');
    assert.throws(() => reject(bytes(source)), new RegExp('at byte ' + at + '$'));
  }
});
test('Template brace budget fails closed without rejecting its exact boundary', () => {
  const nested = count => '`value ${' + '{'.repeat(count) + '42' + '}'.repeat(count) + '}`';
  assert.doesNotThrow(() => reject(bytes(nested(256))));
  assert.throws(() => reject(bytes(nested(257))),
                /template interpolation brace nesting limit exceeded \(256\) at byte [0-9]+/);
});
test('Harmless textual unsafe and identifiers with suffixes are not rejected', () => {
  for (const source of harmless) assert.doesNotThrow(() => reject(bytes(source)));
});
test('UTF-8 offsets and malformed source handling are deterministic', () => {
  const source = '/* café */ unsafe fnc f():int{return 42;}';
  const at = Buffer.byteLength(source.slice(0, source.indexOf('unsafe')));
  assert.throws(() => reject(bytes(source)), new RegExp(`at byte ${at}$`));
  assert.throws(() => reject(bytes('fnc main():int{return 42;} // text\u2028unsafe')), /wasm unsafe boundary unsupported/);
  assert.throws(() => reject(bytes('/* unclosed')), /unterminated block comment/);
  assert.throws(() => reject(bytes('`broken ${unsafe')), /wasm unsafe boundary unsupported/);
  assert.throws(() => reject(Buffer.from([0xff])), /encoded|valid|UTF-8|utf-8/i);
  assert.throws(() => reject(Buffer.from([0xef, 0xbb, 0xbf, ...bytes('unsafe')])),
                /wasm source BOM unsupported at byte 0/);
  assert.throws(() => reject(bytes('/* café */\\0 unsafe'.replace('\\0', '\0'))),
                /wasm source contains NUL at byte 11/);
});

test('Deterministic compositional lexical fuzzer: inert unsafe cannot mask real keyword', () => {
  let seed = 0x25abba11;
  const rnd = n => ((seed ^= seed << 13, seed ^= seed >>> 17,
                     seed ^= seed << 5, seed >>> 0) % n);
  const inert = ['// unsafe\n', '/* unsafe */', '/* /* unsafe */ */',
                 '"unsafe"', "'unsafe'", '`unsafe`', '#unsafe',
                 'unsafe_helper', '_unsafe', 'unsafe_count',
                 '`outer ${"unsafe"}`'];
  const separators = ['\n', '\r', '\r\n', ' ', '\t', '\u2028'];
  for (let i = 0; i < 1000; i++) {
    let prefix = '';
    const length = 1 + rnd(6);
    for (let j = 0; j < length; j++)
      prefix += ' ' + inert[rnd(inert.length)] + separators[rnd(separators.length)];
    assert.doesNotThrow(() => reject(bytes(prefix)));
    let failure;
    try { reject(bytes(prefix + 'unsafe')); } catch (err) { failure = err; }
    assert.equal(failure?.message,
                 'wasm unsafe boundary unsupported: effects and native grants unavailable at byte ' +
                 Buffer.byteLength(prefix, 'utf8'));
  }
});
