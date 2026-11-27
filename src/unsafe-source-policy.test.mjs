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
test('Unsafe stdlib imports are denied even when the package path is quoted', () => {
  const paths = ['ores.std/unsafe', 'ores.std/unsafe/ffi', 'std/unsafe/memory',
                 'std.unsafe.ffi', 'std:unsafe.native', 'ores.std:unsafe',
                 'std/./unsafe/ffi', 'std/other/../unsafe/native',
                 'ores.std//unsafe/memory'];
  for (const path of paths) {
    for (const before of ['import module native_ops from ',
                          'import ns ffi as native_ops from ']) {
      const source = before + '"' + path + '";';
      assert.throws(() => reject(bytes(source)),
                    /wasm unsafe standard-library import unavailable in guest domains at byte [0-9]+/);
    }
  }
  // Import parsing must not misinterpret an ordinary quoted string, comments,
  // or a distinct unsafe_tools namespace as privileged native FFI.
  for (const source of [
    'fnc main():string{return "std/unsafe/ffi";}',
    '// import module ffi from "std/unsafe/ffi";\\nfnc main():int{return 42;}',
    'import module tools from "std/unsafe_tools";',
    'import module tools from "std/./unsafe_tools";',
    'import module tools from "pkg:unsafe";',
  ]) assert.doesNotThrow(() => reject(bytes(source)), source);
});

test('Canonicalized unsafe import matrix cannot be laundered by alias or comments', () => {
  const roots = ['std/unsafe', 'ores.std/unsafe',
                 'std.unsafe', 'ores.std.unsafe',
                 'std:unsafe', 'ores.std:unsafe'];
  const suffixes = ['', '/ffi', '.ffi', '/memory', '/native.ores'];
  const prefixes = ['import module ffi from ',
                    'import module foo as ffi from ',
                    'import module ffi from /* inert */ ',
                    'import module ffi from\\n'];
  let rejected = 0;
  for (const root of roots) for (const suffix of suffixes) {
    const paths = [root + suffix];
    if (root.includes('/')) paths.push(
      root.replace('/', '/./') + suffix,
      root.replace('/', '//') + suffix,
      root.replace('/', '/foo/../') + suffix);
    paths.push('./' + root + suffix,
               '../' + root + suffix,
               'pkg/../' + root + suffix);
    for (const path of paths) for (const prefix of prefixes) {
      assert.throws(() => reject(bytes(prefix + '"' + path + '";')),
                    /wasm unsafe standard-library import unavailable in guest domains/);
      rejected++;
    }
  }
  assert.equal(rejected, 600);
  for (const nearMiss of ['std/unsafe_tools', 'std/unsafe-math',
                          'ores.std/safe', 'pkg:unsafe', 'std/./unsafe_tools',
                          'std/stuff/../safe', 'ores.std:unsafe_tools',
                          'pkg/std/unsafe/memory', 'pkg/std/unsafe_tools']) {
    assert.doesNotThrow(() =>
      reject(bytes('import module tools from "' + nearMiss + '";')));
  }
});

test('Escaped import strings fail before the external compiler can decode them', () => {
  for (const path of [
    String.raw`std\\/unsafe/ffi`,
    String.raw`std\\u002funsafe/ffi`,
    String.raw`ores.std\\/unsafe/native`,
    String.raw`std\\x2funsafe`,
  ]) {
    const source = 'import module ffi from "' + path + '";';
    assert.throws(() => reject(bytes(source)),
      /wasm escaped import path unavailable in guest domains at byte [0-9]+/);
  }
  assert.doesNotThrow(() =>
    reject(bytes(String.raw`fnc main():string{return "std\\/unsafe";}`)));
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

test('Canonical Atto roots and mixed colon delimiter aliases fail closed', () => {
  for (const root of ['std', 'ores.std', 'atto.std', 'atto::std', 'ores::std'])
    for (const separator of ['/', '.', ':', '::'])
      for (const suffix of ['', '/ffi', '.ffi', ':ffi', '::ffi']) {
        const path = root + separator + 'unsafe' + suffix;
        assert.throws(() => reject(bytes('import module innocent from "' + path + '";')),
          /wasm unsafe standard-library import unavailable in guest domains/, path);
      }
  for (const path of ['atto.std/unsafe_tools', 'atto.std:unsafe-math', 'pkg/atto.std/unsafe', 'atto.std/safe'])
    assert.doesNotThrow(() => reject(bytes('import module tools from "' + path + '";')), path);
});

test('unsafe identity cannot be laundered by traversal or mixed root separators', () => {
  for (const path of [
    'std/unsafe/../safe', 'atto.std/unsafe/../safe',
    'atto::std/unsafe/../safe', 'ores:std/unsafe/../safe',
    'atto::std/../safe', 'ores:std/../safe',
    'atto/std/../safe', 'ores/std/../safe',
    'atto.std/other/../unsafe/ffi'
  ]) assert.throws(() => reject(bytes('import module innocent from "' + path + '";')),
    /wasm unsafe standard-library import unavailable in guest domains/, path);
  for (const path of ['atto::std/other/../safe', 'atto/std/other/../safe',
    'atto.std/unsafe_tools', 'pkg/atto.std/unsafe'])
    assert.doesNotThrow(() => reject(bytes('import module innocent from "' + path + '";')), path);
});

test('intermediate canonical unsafe identities and normalized root escapes fail closed', () => {
  for (const path of [
    'std/other/../unsafe/../safe', './std/other/../unsafe/../safe',
    'pkg/../std/other/../unsafe/../safe', 'atto//std/../safe',
    'atto/./std/../safe', './atto::std/../safe',
    'pkg/../ores.std/../safe', 'atto/std/other/../unsafe/../safe',
    'atto/:/std/../safe', 'std/other/../unsafe::ffi/../safe'
  ]) assert.throws(() => reject(bytes('import module innocent from "' + path + '";')),
    /wasm unsafe standard-library import unavailable in guest domains/, path);
  for (const path of [
    'std/other/../safe', './atto::std/other/../safe',
    'pkg/../std/unsafe_tools/../safe', 'pkg/atto.std/unsafe/../safe',
    'atto/std/other/deeper/../../safe'
  ]) assert.doesNotThrow(() => reject(bytes('import module tools from "' + path + '";')), path);
});
