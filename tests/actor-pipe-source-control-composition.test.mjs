import test from 'node:test';
import assert from 'node:assert/strict';
import {TextDecoder as Decoder, TextEncoder as Encoder} from 'node:util';
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

test('prototype RegExp monkeypatch cannot hide reserved actor pipe tokens', () => {
  const source = 'val x = producer pipe! consumer;';
  const prior = RegExp.prototype.test;
  let failure;
  RegExp.prototype.test = () => false;
  try { admitHostOnly(source); } catch (error) { failure = error; }
  finally { RegExp.prototype.test = prior; }
  assert.match(failure?.message ?? '', /wasm actor pipe! source lowering unsupported/);
});

test('global/native TextDecoder monkeypatch cannot rewrite actor source', () => {
  const source = 'val x = consumer rpipe! producer;';
  const originalGlobal = globalThis.TextDecoder;
  const originalNative = Decoder.prototype.decode;
  let failure;
  globalThis.TextDecoder = class {decode() {return 'val x = 42;';}};
  Decoder.prototype.decode = () => 'val x = 42;';
  try { admitHostOnly(source); } catch (error) { failure = error; }
  finally {
    globalThis.TextDecoder = originalGlobal;
    Decoder.prototype.decode = originalNative;
  }
  assert.match(failure?.message ?? '', /wasm actor rpipe! source lowering unsupported/);
});

test('String slicing monkeypatch cannot rename source tokens or fake offsets', () => {
  const source = '// café 🦀\nval x = producer pipe! consumer;';
  const expected = encoder.encode(source.slice(0,source.indexOf('pipe!'))).length;
  const origSlice = String.prototype.slice;
  const origIndexOf = String.prototype.indexOf;
  let failure;
  String.prototype.slice = () => 'safe';
  String.prototype.indexOf = () => -1;
  try { admitHostOnly(source); } catch (error) { failure = error; }
  finally { String.prototype.slice = origSlice; String.prototype.indexOf = origIndexOf; }
  assert.match(failure?.message ?? '', /wasm actor pipe! source lowering unsupported/);
  assert.ok(failure.message.endsWith('at byte '+expected));
});

test('Array includes monkeypatch cannot hide pipe after line comment', () => {
  const source = '// comment\nval x = producer pipe! consumer;';
  const prior = Array.prototype.includes;
  let failure;
  Array.prototype.includes = () => false;
  try { admitHostOnly(source); } catch (error) { failure = error; }
  finally { Array.prototype.includes = prior; }
  assert.match(failure?.message ?? '', /wasm actor pipe! source lowering unsupported/);
});

test('mutated TextEncoder cannot forge physical diagnostic byte offsets', async () => {
  const source = '// café 🦀\nstop! worker;';
  const expected = encoder.encode(source.slice(0,source.indexOf('stop!'))).length;
  const bytes = encoder.encode(source);
  const priorGlobal = globalThis.TextEncoder;
  const priorEncode = Encoder.prototype.encode;
  let failure;
  globalThis.TextEncoder = class {encode() {return new Uint8Array(0);}};
  Encoder.prototype.encode = () => new Uint8Array(0);
  try { rejectRawSourceControls(bytes); rejectUnsupportedActorPipeSource(bytes); } catch (error) { failure = error; }
  finally {globalThis.TextEncoder=priorGlobal; Encoder.prototype.encode=priorEncode;}
  assert.match(failure?.message ?? '', /wasm graceful actor stop! source lowering unsupported/);
  assert.ok(failure.message.endsWith('at byte '+expected));
});

test('native tokenizer catches NUL despite patched String.indexOf', () => {
  const bytes = encoder.encode('let x = 1;\0 stop! worker;');
  const prior = String.prototype.indexOf;
  let failure;
  String.prototype.indexOf = () => -1;
  try { rejectUnsupportedActorPipeSource(bytes); } catch(error) { failure=error; }
  finally {String.prototype.indexOf=prior;}
  assert.match(failure?.message ?? '', /contains NUL byte/);
});

test('Set.has tampering cannot admit bare actor pipes', () => {
  const source='val x = producer pipe consumer;';
  const saved = Set.prototype.has;
  let failure;
  Set.prototype.has = () => true;
  try { admitHostOnly(source); } catch(error) {failure=error;}
  finally {Set.prototype.has=saved;}
  assert.match(failure?.message ?? '', /wasm actor pipe source lowering unsupported/);
});

test('Array.includes tampering cannot admit bare actor pipes and must preserve functional pipes', () => {
  const saved=Array.prototype.includes;
  let failure;
  Array.prototype.includes=()=>false;
  try { admitHostOnly('val x = producer rpipe consumer;'); } catch(error){failure=error;}
  finally {Array.prototype.includes=saved;}
  assert.match(failure?.message ?? '', /wasm actor rpipe source lowering unsupported/);
  assert.doesNotThrow(()=>admitHostOnly('val x = input |> transform;'));
});


test('mutating RegExp.exec cannot admit either direction of actor pipe', () => {
  const prior = RegExp.prototype.exec;
  const seen = [];
  RegExp.prototype.exec = () => null;
  try {
    for(const source of ['val g = p pipe c;', 'val g = c rpipe p;',
      'val g = p pipe! c;', 'val g = c rpipe! p;']) {
      try {admitHostOnly(source);} catch (error) {seen.push(error.message);}
    }
  } finally {RegExp.prototype.exec = prior;}
  assert.equal(seen.length,4);
  for(const message of seen) assert.match(message,/wasm actor (?:r?pipe)!? source lowering unsupported/);
});


test('Array.prototype.push monkeypatch cannot drop unsupported actor tokens', () => {
  const saved=Array.prototype.push;
  let admitted=0;
  const attempts=[
    'val g = producer pipe! consumer;',
    'val g = consumer rpipe! producer;',
    'val g = producer pipe consumer;',
    'val g = consumer rpipe producer;',
    'stop! worker;'
  ];
  Array.prototype.push=()=>0;
  try {
    for (const source of attempts) {
      try { admitHostOnly(source); admitted++; } catch (error) {
        assert.match(error.message,/source lowering unsupported/);
      }
    }
  } finally { Array.prototype.push=saved; }
  assert.equal(admitted,0,'no source may silently pass through empty token list');
});
