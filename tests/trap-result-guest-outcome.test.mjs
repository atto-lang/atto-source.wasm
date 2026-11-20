import test from 'node:test';
import assert from 'node:assert/strict';
import {isRuntimeTrapWithPanicCode} from '../src/trap-result-guest-outcome.mjs';

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
