import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parse_strict_github_json, read_strict_github_response, EvidenceRejected} from '../scripts/strict_github_evidence_20261106.mjs';

const enc = new TextEncoder();
const parse = text => parse_strict_github_json(enc.encode(text));
function rejected(text) {
  assert.throws(() => parse(text), {name: 'EvidenceRejected'});
}
function res(chunks, header) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), {status: 200, headers: header ? {'Content-Length': header} : {}});
}

const positive = [
  ['simple metadata', '{"id":1,"private":true,"archived":false,"disabled":false}'],
  ['nested review', '{"reviews":[{"user":{"login":"ORESoftware"},"state":"APPROVED"}]}'],
  ['escaped unique key', '{"run\\u005fid":42,"other":0}'],
  ['finite fractional and exponential numbers', '{"value":3.25,"ratio":1e-8,"negative":-2}'],
  ['Unicode key and value pair', '{"✔":"café 🎯"}'],
];
for (const [name, source] of positive) test('accept ' + name, () => {
  assert.deepEqual(parse(source), JSON.parse(source));
});
const negative = [
  ['literal duplicate', '{"id":1,"id":2}'],
  ['decoded-key duplicate', '{"id":1,"\\u0069d":2}'],
  ['nested duplicate', '{"a":{"z":1,"z":2}}'],
  ['escaped path separator duplicate', '{"a/b":1,"a\\/b":2}'],
  ['array duplicate object', '{"steps":[{"name":"test","name":"fake"}]}'],
  ['BOM', '\ufeff{"a":1}'],
  ['unpaired high surrogate', '{"a":"\\ud800"}'],
  ['unpaired low surrogate', '{"a":"\\udc00"}'],
  ['nonfinite number overflow', '{"id":1e999}'],
  ['unsafe integer', '{"id":9007199254740993}'],
  ['invalid leading zero', '{"id":01}'],
  ['invalid exponent', '{"id":1e+}'],
  ['invalid escape', '{"id":"\\q"}'],
  ['trailing comma', '{"id":1,}'],
  ['trailing garbage', '{"id":1}true'],
  ['trailing top-level array', '{"id":1}[]'],
  ['non-object top-level array', '[]'],
  ['non-object top-level number', '4'],
  ['object missing member', '{"a":}'],
  ['unclosed string', '{"a":"open}'],
  ['unclosed array', '{"a":[1,2}'],
  ['unknown token', '{"a":undefined}'],
  ['bad separators', '{"a":1 "b":2}'],
  ['oversized integer token', '{"a":' + '9'.repeat(129) + '}'],
  ['maximum nesting guard', '{"a":' + '['.repeat(41) + '0' + ']'.repeat(41) + '}'],
];
for (const [name, source] of negative) test('deny ' + name, () => rejected(source));

test('deny invalid UTF-8 bytes', () => {
  assert.throws(() => parse_strict_github_json(new Uint8Array([0x7b,0x22,0xff,0x22,0x7d])), EvidenceRejected);
});
test('accept bounded multi-chunk response', async () => {
  assert.deepEqual(await read_strict_github_response(res([enc.encode('{"ok":'),enc.encode('true}')])), {ok:true});
});
test('deny oversize content-length before reading', async () => {
  await assert.rejects(read_strict_github_response(res([enc.encode('{}')], '1048577')), EvidenceRejected);
});
test('deny stream exceeding byte limit', async () => {
  await assert.rejects(read_strict_github_response(res([new Uint8Array(1048576), new Uint8Array([0x7b])])), EvidenceRejected);
});
test('deny mismatch declared length', async () => {
  await assert.rejects(read_strict_github_response(res([enc.encode('{}')], '3')), EvidenceRejected);
});
test('deny invalid noncanonical content-length', async () => {
  await assert.rejects(read_strict_github_response(res([enc.encode('{}')], '0002')), EvidenceRejected);
});
test('deny non-200 response without reading data', async () => {
  await assert.rejects(read_strict_github_response(new Response('{}', {status: 403})), EvidenceRejected);
});

test('permit decoded gzip-length mismatch but still enforce body budget', async () => {
  const response = res([enc.encode('{\"ok\":true}')], '3');
  response.headers.set('content-encoding', 'gzip');
  assert.deepEqual(await read_strict_github_response(response), {ok:true});
});
