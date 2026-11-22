import test from 'node:test';
import assert from 'node:assert/strict';
import {rejectUnsupportedActorThreadSource} from '../src/actor-max-threads-source-policy.mjs';

const check = source => rejectUnsupportedActorThreadSource(new TextEncoder().encode(source));

test('caller-shadowed byteLength does not bypass native 1 MiB admission', () => {
  const oversized = new Uint8Array(1_048_577);
  let inspected = 0;
  Object.defineProperty(oversized, 'byteLength', {
    get() {inspected++; return 1;}
  });
  assert.throws(() => rejectUnsupportedActorThreadSource(oversized), /1 MiB byte budget/);
  assert.equal(inspected, 0);
});

test('comment nesting at exactly 128 is allowed, 129 is refused', () => {
  assert.doesNotThrow(() => check('/*'.repeat(128) + '*/'.repeat(128)));
  assert.throws(() => check('/*'.repeat(129) + '*/'.repeat(129)), /comment nesting exceeded/);
});

test('invalid encoded bytes and NUL are denied prior to guest compilation', () => {
  assert.throws(() => rejectUnsupportedActorThreadSource(Uint8Array.of(0xff)), TypeError);
  assert.throws(() => rejectUnsupportedActorThreadSource(Uint8Array.of(0)), /NUL byte/);
});

test('shared source backing is refused, without a private copy fallback', () => {
  if (typeof SharedArrayBuffer === 'function') {
    assert.throws(
      () => rejectUnsupportedActorThreadSource(new Uint8Array(new SharedArrayBuffer(8))),
      /shared source backing/
    );
  }
});
