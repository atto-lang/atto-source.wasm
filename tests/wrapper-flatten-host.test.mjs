import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {None, Some, flattenOption, flattenFuture} from '../src/wrapper-flatten-host.mjs';

test('nested option state is preserved until explicit flatten', () => {
  const nested = Some(Some(Some(42)));
  const storedNone = Some(None);
  assert.equal(storedNone.tag, 'some');
  assert.equal(storedNone.value, None);
  assert.equal(flattenOption(storedNone), None);
  assert.deepEqual(flattenOption(nested), Some(42));
  assert.equal(flattenOption(None), None);
  assert.throws(() => flattenOption({tag:'some',value:42}), /Option required/);
});

test('native Promise adoption waits for innermost completion', async () => {
  let complete;
  const inner = new Promise(resolve => {complete = resolve;});
  const outer = Promise.resolve().then(() => inner);
  const result = flattenFuture(outer);
  let finished = false;
  result.then(() => {finished = true;});
  await Promise.resolve();
  assert.equal(finished, false);
  complete(42);
  assert.equal(await result, 42);
});

test('deep already settled promise chains are stack safe', async () => {
  let source = Promise.resolve(77);
  for (let i=0; i<2048; i++) {
    const previous=source;
    source=Promise.resolve().then(() => previous);
  }
  assert.equal(await flattenFuture(source), 77);
});

test('observer abort does not cancel the producer', async () => {
  const c = new AbortController();
  let done;
  const source = new Promise(resolve => {done=resolve;});
  const observed = flattenFuture(source, {signal:c.signal});
  const expected = assert.rejects(observed, /cancelled/);
  c.abort(new Error('cancelled observer'));
  await expected;
  done(9);
  assert.equal(await source, 9);
});

test('inner failure stays failure; rejection is handled', async () => {
  const error = new Error('boom');
  await assert.rejects(flattenFuture(Promise.resolve().then(() => Promise.reject(error))), e => e === error);
  assert.throws(() => flattenFuture({then(resolve){resolve(5);}}), /Promise required/);
});

test('execute shared v1 Option vectors through host implementation', () => {
  const vectors = JSON.parse(readFileSync(new URL('../contracts/v1/wrapper-flattening-v1.json', import.meta.url)));
  assert.equal(vectors.schema, 'oreslang.wrapper-flattening.v1');
  const decode = node => node?.tag === 'none' ? None : node?.tag === 'some'
    ? Some(decode(node.value)) : node;
  const encode = node => node === None ? {tag: 'none'} : node?.tag === 'some'
    ? {tag: 'some', value: encode(node.value)} : node;
  for (const vector of vectors.option_cases) {
    const nested = decode(vector.input);
    assert.deepEqual(encode(flattenOption(nested)), vector.after_explicit_flatten, vector.id);
  }
  assert.equal(vectors.type_cases.length, 6);
  assert.equal(vectors.future_runtime_cases.length, 8);
});
