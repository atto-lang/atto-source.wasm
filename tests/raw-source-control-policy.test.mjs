import test from 'node:test';
import assert from 'node:assert/strict';
import {types, TextDecoder as NodeTextDecoder} from 'node:util';
import {rejectRawSourceControls} from '../src/raw-source-control-policy.mjs';
const check = source => rejectRawSourceControls(new TextEncoder().encode(source));

test('rejects terminal controls in code, comments, and literals', () => {
  for (const ch of ['\u001b', '\u007f']) {
    for (const source of ['fnc main():int { '+ch+' return 42; }',
      '// hidden '+ch+' line\nfnc main():int{return 42;}',
      'fnc main():int { let s = "x'+ch+'"; return 42; }']) {
      assert.throws(() => check(source), /WASM_SOURCE_CONTROL_REJECTED/);
    }
  }
});

test('rejects bidi marks, overrides, and isolates at their exact UTF-8 byte offset', () => {
  for (const ch of ['\u061c','\u200e','\u200f','\u202a','\u202b','\u202c',
    '\u202d','\u202e','\u2066','\u2067','\u2068','\u2069']) {
    const source = '// café '+ch+' masked\n';
    // ASCII '// caf' (6 bytes) plus U+00E9 (2 bytes) and a space.
    assert.throws(() => check(source),
      error => error.message.includes('at byte 9') &&
        error.message.includes('U+'+ch.codePointAt(0).toString(16).toUpperCase().padStart(4,'0')));
  }
});

test('preserves valid NEL, CR, LF, line-separator, and paragraph-separator whitespace', () => {
  assert.doesNotThrow(() => check('fnc main():int{return 42;}\u0085// comment\r\n\u2028\u2029'));
  // Escaped source spelling has ASCII backslash-u bytes, not the dangerous raw code point.
  assert.doesNotThrow(() => check('fnc main():int { let label = "\\u202e"; return 42; }'));
});

test('rejects Proxy and shared backing without inspecting attacker-controlled accessors', () => {
  let accessed = 0;
  const proxy = new Proxy(new Uint8Array([65]), {
    get() { accessed++; throw new Error('proxy getter called'); }
  });
  assert.throws(() => rejectRawSourceControls(proxy), /genuine Uint8Array/);
  assert.equal(accessed, 0);
  if (typeof SharedArrayBuffer !== 'undefined')
    assert.throws(() => rejectRawSourceControls(new Uint8Array(new SharedArrayBuffer(2))), /shared/);
});

test('enforces physical byte budget and fatal UTF-8 decoding', () => {
  const oversized = new Uint8Array(1_048_577);
  Object.defineProperty(oversized, 'byteLength', {value: 1});
  assert.throws(() => rejectRawSourceControls(oversized), /1 MiB/);
  assert.throws(() => rejectRawSourceControls(new Uint8Array([0xc3,0x28])), /encoded|valid|UTF/i);
});


test('mutating util.types after import cannot authorize shared source backing', () => {
  if (typeof SharedArrayBuffer === 'undefined') return;
  const prior = types.isSharedArrayBuffer;
  types.isSharedArrayBuffer = () => false;
  try {
    assert.throws(() => rejectRawSourceControls(new Uint8Array(new SharedArrayBuffer(8))), /shared/);
  } finally { types.isSharedArrayBuffer = prior; }
});

test('mutating global TextDecoder cannot mask raw Unicode overrides', () => {
  const previous = globalThis.TextDecoder;
  globalThis.TextDecoder = class {decode() {return 'safe';}};
  try {
    assert.throws(() => check('/* \u202e */'), /WASM_SOURCE_CONTROL_REJECTED/);
  } finally { globalThis.TextDecoder = previous; }
});

test('mutating native decoder method after import cannot mask control marks', () => {
  const original = NodeTextDecoder.prototype.decode;
  NodeTextDecoder.prototype.decode = () => 'safe';
  try {
    assert.throws(() => check('/* \u2068 */'), /WASM_SOURCE_CONTROL_REJECTED/);
  } finally { NodeTextDecoder.prototype.decode = original; }
});

test('mutating RegExp.test and String iteration cannot mask controls', () => {
  const priorTest = RegExp.prototype.test;
  const priorIterator = String.prototype[Symbol.iterator];
  RegExp.prototype.test = () => false;
  String.prototype[Symbol.iterator] = function*() { yield 'safe'; };
  try {
    assert.throws(() => check('/* \u202d */'), /WASM_SOURCE_CONTROL_REJECTED/);
  } finally {
    RegExp.prototype.test = priorTest;
    String.prototype[Symbol.iterator] = priorIterator;
  }
});

test('mutating code-point and byte-length helpers cannot move offsets or mask controls', () => {
  const priorCode = String.prototype.codePointAt;
  const priorByteLength = Buffer.byteLength;
  String.prototype.codePointAt = () => 0x61;
  Buffer.byteLength = () => 1;
  try {
    assert.throws(() => check('// café \u2066'), error =>
      error.message.includes('U+2066') && error.message.includes('at byte 9'));
  } finally {
    String.prototype.codePointAt = priorCode;
    Buffer.byteLength = priorByteLength;
  }
});


test('monkeypatched native byte-view getter call cannot spoof backing or length', () => {
  const proto = Object.getPrototypeOf(Uint8Array.prototype);
  const bufferGetter = Object.getOwnPropertyDescriptor(proto, 'buffer').get;
  const lengthGetter = Object.getOwnPropertyDescriptor(proto, 'byteLength').get;
  const oldBufferCall = Object.getOwnPropertyDescriptor(bufferGetter, 'call');
  const oldLengthCall = Object.getOwnPropertyDescriptor(lengthGetter, 'call');
  Object.defineProperty(bufferGetter, 'call', {
    configurable: true, value: () => new ArrayBuffer(8)
  });
  Object.defineProperty(lengthGetter, 'call', {
    configurable: true, value: () => 1
  });
  try {
    if (typeof SharedArrayBuffer !== 'undefined')
      assert.throws(() => rejectRawSourceControls(new Uint8Array(new SharedArrayBuffer(8))), /shared/);
    assert.throws(() => rejectRawSourceControls(new Uint8Array(1_048_577)), /1 MiB/);
  } finally {
    if (oldBufferCall) Object.defineProperty(bufferGetter, 'call', oldBufferCall);
    else delete bufferGetter.call;
    if (oldLengthCall) Object.defineProperty(lengthGetter, 'call', oldLengthCall);
    else delete lengthGetter.call;
  }
});
