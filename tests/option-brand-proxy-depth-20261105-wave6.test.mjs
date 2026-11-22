import test from 'node:test';
import assert from 'node:assert/strict';
import {Some, None, flattenOption} from '../src/wrapper-flatten-host.mjs';

test('a proxy around a branded Option does not inherit its identity', () => {
  const actual = Some(42);
  let inspected = 0;
  const impostor = new Proxy(actual, {get(target, key) {inspected++; return Reflect.get(target, key);}});
  assert.throws(() => flattenOption(impostor), /Option required/);
  assert.strictEqual(flattenOption(Some(impostor)).value, impostor);
  assert.equal(inspected, 0);
});

test('deep finite nesting preserves one terminal wrapper without flattening its referent', () => {
  const payload = Object.create(null);
  payload.state = 'unchanged';
  const terminal = Some(payload);
  let wrapped = terminal;
  for (let i = 0; i < 256; i++) wrapped = Some(wrapped);
  assert.strictEqual(flattenOption(wrapped), terminal);
  assert.strictEqual(terminal.value, payload);
  assert.ok(Object.isFrozen(terminal));
  assert.equal(payload.state, 'unchanged');
});

test('an unbranded lookalike cannot manufacture None or an Option', () => {
  assert.throws(() => flattenOption({tag:'none'}), /Option required/);
  assert.throws(() => flattenOption(Object.create(None)), /Option required/);
  assert.strictEqual(flattenOption(Some(Some(None))), None);
});
