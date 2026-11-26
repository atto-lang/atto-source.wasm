import test from 'node:test';
import assert from 'node:assert/strict';
import {checkedUnwrapRejections, verifyCheckedUnwrapRejection as verify} from '../src/checked-unwrap-rejections.mjs';

for (const [id, source, code] of checkedUnwrapRejections) {
  test(id + ': only matching compiler diagnostic with no guest bytes counts', () => {
    assert.ok(source.includes('.unwrap('));
    for (const diagnostic of [code + ': actual diagnostic', '2:14: ' + code + ': actual diagnostic'])
      assert.doesNotThrow(() => verify(id, {ok:false, diagnostic}));
    for (const result of [
      {ok:true, diagnostic:code + ': actual diagnostic'},
      {ok:false, diagnostic:'E_SYNTAX: unexpected token'},
      {ok:false, diagnostic:'E_TYPE: ' + code + ': merely text'},
      {ok:false, diagnostic:code + '_EXTRA: wrong class'},
      {ok:false, diagnostic:''},
      {ok:false, diagnostic:code + ': '},
      {ok:false, diagnostic:code + ':   '},
      {ok:false, diagnostic:code + ': a\n'},
      {ok:false, diagnostic:code + ': a\nsecond diagnostic'},
      {ok:false, diagnostic:code + ': a', wasm:new Uint8Array()},
      {ok:false, diagnostic:code + ': ' + 'x'.repeat(16384)},
      null
    ]) assert.throws(() => verify(id, result), /diagnostic mismatch/);
  });
}
test('unknown rejection and mutable oracle fail closed', () => {
  assert.throws(() => verify('unknown', {ok:false, diagnostic:'E_EFFECT: x'}), /diagnostic mismatch/);
  assert.ok(Object.isFrozen(checkedUnwrapRejections));
  assert.ok(checkedUnwrapRejections.every(Object.isFrozen));
});
