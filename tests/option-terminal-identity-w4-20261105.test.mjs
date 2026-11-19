import test from 'node:test';
import assert from 'node:assert/strict';
import {Some, None, flattenOption} from '../src/wrapper-flatten-host.mjs';

test('scalar payloads remain inside a single terminal Some without numeric coercion', () => {
  for (const scalar of [-0, NaN, 0n, false, '', undefined, null]) {
    const terminal = Some(scalar);
    assert.strictEqual(flattenOption(Some(terminal)), terminal);
    assert.ok(Object.is(flattenOption(Some(terminal)).value, scalar));
  }
});

test('unbranded nested data with a throwing tag getter is not inspected', () => {
  let calls = 0;
  const payload = Object.create(null);
  Object.defineProperty(payload, 'tag', {get() { calls++; throw Error('untrusted tag'); }});
  const terminal = Some(payload);
  assert.strictEqual(flattenOption(Some(Some(terminal))), terminal);
  assert.strictEqual(terminal.value, payload);
  assert.equal(calls, 0);
});

test('None remains the one nominal terminal even inside multiple Some wrappers', () => {
  assert.strictEqual(flattenOption(Some(Some(Some(None)))), None);
  assert.strictEqual(flattenOption(None), None);
});
