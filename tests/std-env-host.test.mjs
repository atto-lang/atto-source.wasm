import {test} from 'node:test';
import assert from 'node:assert/strict';
import {create_scoped_env_host, EnvHostError} from '../src/std-env-host.mjs';

test('std/env host snapshot preserves absence vs empty and copies allowed values', () => {
  const values = {PUBLIC_NAME: 'atto', PUBLIC_EMPTY: ''};
  const allow = ['PUBLIC_*'];
  const host = create_scoped_env_host({values, allow, environmentCapability: true});
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
    values, allow: ['*'], deny: ['PUBLIC_SECRET'], environmentCapability: true
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

test('coarse isolate grant is independent of scoped allow rules', () => {
  let inspected = 0;
  const values = {};
  Object.defineProperty(values, 'ALLOW_ME', {
    enumerable: true, get() { inspected++; throw Error('must not read without coarse grant'); }
  });
  const host = create_scoped_env_host({values, allow: ['*'], environmentCapability: false});
  assert.throws(() => host.get('ALLOW_ME'), /ENV_PERMISSION_DENIED/);
  assert.throws(() => host.has('ALLOW_ME'), /ENV_PERMISSION_DENIED/);
  assert.equal(inspected, 0);
  assert.throws(() => create_scoped_env_host({environmentCapability: 'true'}),
    /ENV_INVALID_POLICY/);
});

test('no coarse ENV authority means no host key metadata enumeration', () => {
  const values = new Proxy(Object.create(null), {
    ownKeys() { throw Error('UNAUTHORIZED_KEY_ENUMERATION'); }
  });
  const host = create_scoped_env_host({
    values, allow: ['*'], environmentCapability: false
  });
  assert.throws(() => host.get('ATTO_SECRET'), /ENV_PERMISSION_DENIED/);
  assert.throws(() => host.has('ATTO_SECRET'), /ENV_PERMISSION_DENIED/);
});

test('explicit isolate retirement revokes reads, probes and retained snapshot', () => {
  const host = create_scoped_env_host({
    values: {KEY: 'private'}, allow: ['KEY'], environmentCapability: true
  });
  assert.deepEqual(host.get('KEY'), {some: true, value: 'private'});
  assert.equal(host.revoke(), true);
  assert.equal(host.revoke(), false);
  assert.throws(() => host.get('KEY'), /ENV_PERMISSION_DENIED/);
  assert.throws(() => host.has('KEY'), /ENV_PERMISSION_DENIED/);
});

test('malformed policy, invalid names, getters and oversize values fail closed', () => {
  const make = (values, allow = ['*']) => create_scoped_env_host({values, allow, environmentCapability: true});
  assert.throws(() => make({GOOD: 'x'}, ['GOOD=BAD']), /ENV_INVALID_POLICY/);
  assert.throws(() => make({GOOD: 'x'}, [42]), /ENV_INVALID_POLICY/);
  assert.throws(() => make({GOOD: 'x'}, ['*']).get('BAD=KEY'), /ENV_INVALID_NAME/);
  assert.throws(() => make({GOOD: 'x'}, ['*']).get(''), /ENV_INVALID_NAME/);
  assert.throws(() => make({GOOD: 'x'}, ['*']).get('A\\0B'), /ENV_INVALID_NAME/);
  assert.throws(() => make({GOOD: 'x'.repeat(16385)}), /ENV_INVALID_SNAPSHOT/);
  assert.throws(() => make({GOOD: 'é'.repeat(8193)}), /ENV_INVALID_SNAPSHOT/);
  assert.throws(() => make({GOOD: String.fromCharCode(0)}), /ENV_INVALID_SNAPSHOT/);
  assert.throws(() => make({GOOD: String.fromCharCode(0xd800)}), /ENV_INVALID_SNAPSHOT/);
  assert.throws(() => make({GOOD: String.fromCharCode(0xdc00)}), /ENV_INVALID_SNAPSHOT/);
  assert.deepEqual(make({GOOD: '🎯'}).get('GOOD'), {some: true, value: '🎯'});
  const object = {};
  Object.defineProperty(object, 'GOOD', {get() { throw Error('accessor called'); }});
  assert.throws(() => make(object), /ENV_INVALID_SNAPSHOT/);
  assert.ok(EnvHostError.prototype instanceof Error);
});

test('portable aggregate 1 MiB budget allows exact ceiling and rejects overflow', () => {
  const values = Object.fromEntries(Array.from({length: 64}, (_, i) =>
    ['BUDGET_' + i, 'x'.repeat(16384)]));
  const host = create_scoped_env_host({
    values, allow: ['BUDGET_*'], environmentCapability: true
  });
  assert.equal(host.has('BUDGET_63'), true);
  assert.throws(() => create_scoped_env_host({
    values: {...values, BUDGET_OVERFLOW: 'x'},
    allow: ['BUDGET_*'], environmentCapability: true
  }), /ENV_INVALID_SNAPSHOT/);
});

test('denied key neither contributes to aggregate budget nor triggers its getter', () => {
  const values = Object.fromEntries(Array.from({length: 64}, (_, i) =>
    ['BUDGET_' + i, 'x'.repeat(16384)]));
  let deniedReads = 0;
  Object.defineProperty(values, 'BUDGET_DENIED', {
    enumerable: true,
    get() { deniedReads++; throw Error('denied secret inspected'); }
  });
  const host = create_scoped_env_host({
    values, allow: ['BUDGET_*'], deny: ['BUDGET_DENIED'],
    environmentCapability: true
  });
  assert.equal(host.has('BUDGET_0'), true);
  assert.throws(() => host.has('BUDGET_DENIED'), /ENV_PERMISSION_DENIED/);
  assert.equal(deniedReads, 0);
});
