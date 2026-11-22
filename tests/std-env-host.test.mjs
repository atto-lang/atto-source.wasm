import {test} from 'node:test';
import assert from 'node:assert/strict';
import {create_scoped_env_host, EnvHostError} from '../src/std-env-host.mjs';

test('std/env host snapshot preserves absence vs empty and copies allowed values', () => {
  const values = {PUBLIC_NAME: 'atto', PUBLIC_EMPTY: ''};
  const allow = ['PUBLIC_*'];
  const host = create_scoped_env_host({values, allow});
  values.PUBLIC_NAME = 'changed';
  allow.push('*');
  assert.deepEqual(host.get('PUBLIC_NAME'), {some: true, value: 'atto'});
  assert.deepEqual(host.get('PUBLIC_EMPTY'), {some: true, value: ''});
  assert.deepEqual(host.get('PUBLIC_ABSENT'), {some: false});
  assert.equal(host.has('PUBLIC_EMPTY'), true);
  assert.equal(host.has('PUBLIC_ABSENT'), false);
  assert.throws(() => host.has('SECRET'), /ENV_PERMISSION_DENIED/);
});

test('deny overrides wildcard allow, including existence probes', () => {
  let secretReads = 0;
  const values = {PUBLIC_SAFE: 'ok'};
  Object.defineProperty(values, 'PUBLIC_SECRET', {
    enumerable: true, get() { secretReads++; throw Error('must not inspect denied value'); }
  });
  const host = create_scoped_env_host({
    values, allow: ['*'], deny: ['PUBLIC_SECRET']
  });
  assert.deepEqual(host.get('PUBLIC_SAFE'), {some: true, value: 'ok'});
  assert.throws(() => host.get('PUBLIC_SECRET'), /ENV_PERMISSION_DENIED/);
  assert.throws(() => host.has('PUBLIC_SECRET'), /ENV_PERMISSION_DENIED/);
  assert.equal(secretReads, 0);
});

test('no default capability and no ambient fallback', () => {
  const host = create_scoped_env_host({values: {PATH: 'injected'}});
  assert.throws(() => host.get('PATH'), /ENV_PERMISSION_DENIED/);
  assert.throws(() => host.has('PATH'), /ENV_PERMISSION_DENIED/);
});

test('malformed policy, invalid names, getters and oversize values fail closed', () => {
  const make = (values, allow = ['*']) => create_scoped_env_host({values, allow});
  assert.throws(() => make({GOOD: 'x'}, ['GOOD=BAD']), /ENV_INVALID_POLICY/);
  assert.throws(() => make({GOOD: 'x'}, [42]), /ENV_INVALID_POLICY/);
  assert.throws(() => make({GOOD: 'x'}, ['*']).get('BAD=KEY'), /ENV_INVALID_NAME/);
  assert.throws(() => make({GOOD: 'x'}, ['*']).get(''), /ENV_INVALID_NAME/);
  assert.throws(() => make({GOOD: 'x'}, ['*']).get('A\\0B'), /ENV_INVALID_NAME/);
  assert.throws(() => make({GOOD: 'x'.repeat(16385)}), /ENV_INVALID_SNAPSHOT/);
  const object = {};
  Object.defineProperty(object, 'GOOD', {get() { throw Error('accessor called'); }});
  assert.throws(() => make(object), /ENV_INVALID_SNAPSHOT/);
  assert.ok(EnvHostError.prototype instanceof Error);
});
