import test from 'node:test';
import assert from 'node:assert/strict';
import {rejectRawSourceControls} from '../src/raw-source-control-policy.mjs';
import {rejectUnsupportedActorPipeSource} from '../scripts/compile-ores.mjs';

const encoder = new TextEncoder();
const admitHostOnly = source => {
  const bytes = encoder.encode(source);
  // Preserve the compiler bridge's source-admission order.
  rejectRawSourceControls(bytes);
  rejectUnsupportedActorPipeSource(bytes);
};

test('raw control check denies deceptive input before actor-pipe admission', () => {
  for (const source of [
    '/* \u202e */ val x = producer pipe! consumer;',
    '"\u2066" val x = consumer rpipe! producer;',
    '// ESC \u001b\nstop! worker;',
  ]) assert.throws(() => admitHostOnly(source), /WASM_SOURCE_CONTROL_REJECTED/);
});

test('pipe!, rpipe!, and stop! source cannot reach scalar guest compilation', () => {
  for (const source of [
    'val x = producer pipe! consumer;',
    'val x = consumer rpipe! producer;',
    'stop! worker;',
  ]) assert.throws(() => admitHostOnly(source), /source lowering unsupported/);
});

test('unsupported pipeline error offsets count UTF-8 bytes, not UTF-16 units', () => {
  for (const expression of [
    'val x = producer pipe! consumer;',
    'val x = consumer rpipe! producer;',
    'stop! worker;',
  ]) {
    const source = '// café 🦀\n' + expression;
    const token = expression.includes('rpipe!') ? 'rpipe!' :
      expression.includes('pipe!') ? 'pipe!' : 'stop!';
    const offset = encoder.encode(source.slice(0, source.indexOf(token))).byteLength;
    assert.throws(() => admitHostOnly(source), error =>
      error.message.endsWith('at byte ' + offset), source);
  }
});

test('non-pipeline literals and function-pipe syntax stay admissible', () => {
  for (const source of [
    'fnc pipe(x:int):int{return x;}',
    'val x = "producer pipe! consumer";',
    '// producer rpipe! consumer\nval x = 42;',
    'val x = input |> transform;',
    'val stop = 1;',
  ]) assert.doesNotThrow(() => admitHostOnly(source), source);
});

test('raw byte-length limit remains enforced before actor lowering', () => {
  const bytes = new Uint8Array(1_048_577);
  assert.throws(() => rejectRawSourceControls(bytes), /1 MiB/);
});
