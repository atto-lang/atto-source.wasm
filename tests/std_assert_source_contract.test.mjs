// wasm source-only guard; NOT an Atto compiled-guest test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = (path) => readFileSync(resolve(root, path), 'utf8');

test('typed runtime assertions are retained as source', () => {
  const code = src('stdlib/std/assert.atto');
  for (const signature of [
    'class AssertionError extends Error',
    'pub fnc true(bool condition): void',
    'pub fnc false(bool condition): void',
    'pub fnc equal<T: Eq>(T expected, T actual): void',
    'pub fnc not_equal<T: Eq>(T expected, T actual): void',
    'pub fnc fail(String message): void'
  ]) assert.ok(code.includes(signature), signature);
  assert.equal(code.split('throw new AssertionError(').length - 1, 5);
  for (const forbidden of ['rt fail(', 'abort(', 'panic(', 'raise(']) {
    assert.equal(code.includes(forbidden), false, forbidden);
  }
});

test('test assertion outcomes and integer bounds are nonthrowing', () => {
  const code = src('stdlib/std/test_assert.atto');
  for (const fragment of [
    'class TestOutcome', 'pub val bool passed;', 'pub val String message;',
    'return new TestOutcome(false, message)',
    'low_inclusive > high_inclusive', 'actual < low_inclusive',
    'actual > high_inclusive'
  ]) assert.ok(code.includes(fragment), fragment);
  assert.equal(code.includes('throw new'), false);
  assert.equal(code.includes('rt fail('), false);
});

test('guest fixtures are present but not claimed as executed', () => {
  const folder = 'tests/fixtures/std-assert-v1/';
  for (const name of ['pass', 'fail-unequal', 'reject-mixed-eq']) {
    assert.ok(src(folder + name + '.atto').includes('NOT_EXECUTED'));
  }
  const pass = src(folder + 'pass.atto');
  assert.ok(pass.includes('import module assert from pkg "std.assert"'));
  for (const member of ['assert.true(', 'assert.false(', 'assert.equal(', 'assert.not_equal(']) {
    assert.ok(pass.includes(member), member);
  }
});
