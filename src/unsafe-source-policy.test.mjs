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
});
