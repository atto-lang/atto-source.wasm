import test from 'node:test';
import assert from 'node:assert/strict';
import {isRuntimeTrapWithPanicCode, guardHostImport, HostImportFault} from '../src/trap-result-guest-outcome.mjs';

// Minimal genuine Wasm instruction sequence: exported main() executes
// unreachable. This is a host-policy test, not compiled AttoLang evidence.
const unreachableWasm = Uint8Array.from([
  0, 97, 115, 109, 1, 0, 0, 0,
  1, 4, 1, 96, 0, 0,
  3, 2, 1, 0,
  7, 8, 1, 4, 109, 97, 105, 110, 0, 0,
  10, 5, 1, 3, 0, 0, 11
]);

test('actual Wasm unreachable trap with matching panic code is classified', () => {
  const module = new WebAssembly.Module(unreachableWasm);
  const instance = new WebAssembly.Instance(module, {});
  // Check the error thrown by this actual WebAssembly instruction, not
  // an Error synthesized by JavaScript or a host import adapter.
  let error;
  try { instance.exports.main(); } catch (caught) { error = caught; }
  assert.ok(error instanceof WebAssembly.RuntimeError);
  assert.equal(isRuntimeTrapWithPanicCode(error, 1), true);
  assert.equal(isRuntimeTrapWithPanicCode(error, 0), false);
  assert.equal(isRuntimeTrapWithPanicCode(error, '1'), false);
  assert.equal(isRuntimeTrapWithPanicCode(error, 7), false);
  assert.equal(isRuntimeTrapWithPanicCode(error, 7, 7), true);
  assert.equal(isRuntimeTrapWithPanicCode(error, 1, 7), false);
  assert.equal(isRuntimeTrapWithPanicCode(error, 9, 9), false);
});

test('host callback faults cannot impersonate a checked-overflow guest trap', () => {
  for (const error of [
    new Error('invalid guest string pointer'),
    new RangeError('out-of-bounds host read'),
    new TypeError('invalid import'),
    new WebAssembly.CompileError('invalid module'),
    new WebAssembly.LinkError('bad import')
  ]) {
    assert.equal(isRuntimeTrapWithPanicCode(error, 1), false,
      error.constructor.name);
  }
});

// A genuine Wasm main() imports atto.print_i64, calls it once, and returns.
// This exercises JS exceptions across a real Wasm import boundary rather than
// only invoking the wrapper directly.
const importedCallbackWasm = Uint8Array.from([
  0, 97, 115, 109, 1, 0, 0, 0,
  1, 8, 2, 96, 1, 126, 0, 96, 0, 0,
  2, 18, 1, 4, 97, 116, 116, 111, 9, 112, 114, 105, 110, 116,
  95, 105, 54, 52, 0, 0,
  3, 2, 1, 1,
  7, 8, 1, 4, 109, 97, 105, 110, 0, 1,
  10, 8, 1, 6, 0, 66, 1, 16, 0, 11
]);

test('Wasm host-import RuntimeError cannot impersonate an overflow panic', () => {
  assert.ok(WebAssembly.validate(importedCallbackWasm));
  const module = new WebAssembly.Module(importedCallbackWasm);
  for (const hostileError of [
    new WebAssembly.RuntimeError('forged guest trap'),
    new Error('ordinary host import failure')
  ]) {
    const guarded = guardHostImport('print_i64', () => { throw hostileError; });
    const instance = new WebAssembly.Instance(module, {
      atto: {print_i64: guarded}
    });
    let caught;
    try { instance.exports.main(); } catch (failure) { caught = failure; }
    assert.ok(caught instanceof HostImportFault);
    assert.notEqual(caught, hostileError);
    assert.equal(isRuntimeTrapWithPanicCode(caught, 1), false);
    assert.equal(isRuntimeTrapWithPanicCode(caught, 7, 7), false);
    assert.equal(caught.message, 'host import failed: print_i64');
  }
});

test('guarded Wasm host import preserves normal successful calls', () => {
  const module = new WebAssembly.Module(importedCallbackWasm);
  const received = [];
  const instance = new WebAssembly.Instance(module, {
    atto: {print_i64: guardHostImport('print_i64', value => received.push(value))}
  });
  instance.exports.main();
  assert.deepEqual(received, [1n]);
  assert.throws(() => guardHostImport('../unsafe', () => {}), TypeError);
  assert.throws(() => guardHostImport('print_i64', {}), TypeError);
});
