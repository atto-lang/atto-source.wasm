#!/usr/bin/env node
/** Exact-source, artifact-driven proof for the /play/ closure/functor sample.
 * This repository is NOT another Atto compiler. No download or publication.
 * A matching candidate digest is NOT independent public release approval.
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

export const CONTRACT = Object.freeze({
  compilerHead: '2ce03b0ebbb9473dbefcfe5918dda446216fd1a0',
  compilerTree: '4598100f13a81587264356a5a6cddea43370fa3f',
  siteExampleBlob: '5d3fa82fa5c554f2a92ad7c5bb75f43a7dc7c977',
  compilerAbi: 2,
  guestAbi: 'atto.browser.guest.v2',
  expectedMain: 84n,
});
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const gitBlob = bytes =>
  createHash('sha1').update('blob ' + bytes.byteLength + '\0').update(bytes).digest('hex');

export function verifyPins({sourceHead, sourceTree, sampleBytes, candidateBytes, candidateSha256}) {
  assert.ok(sourceHead === CONTRACT.compilerHead, 'compiler source head differs from reviewed candidate');
  assert.ok(sourceTree === CONTRACT.compilerTree, 'compiler source tree differs from reviewed candidate');
  assert.equal(gitBlob(sampleBytes), CONTRACT.siteExampleBlob, 'site sample not exact PR #126 Git blob');
  assert.ok(/^[a-f0-9]{64}$/.test(candidateSha256 ?? ''), 'missing explicit candidate digest');
  assert.ok(candidateBytes.byteLength >= 8 && candidateBytes.byteLength <= 1024 * 1024,
    'candidate compiler exceeds safe artifact size bounds');
  assert.equal(sha256(candidateBytes), candidateSha256, 'candidate compiler digest mismatch');
  return true;
}

const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', {fatal: true});
function bounded(value, limit, label) {
  assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= limit, label + ' invalid');
  return value;
}

export function verifyAndRun({compilerBytes, sampleBytes, candidateSha256, sourceHead, sourceTree}) {
  verifyPins({sourceHead, sourceTree, sampleBytes, candidateBytes: compilerBytes, candidateSha256});
  assert.ok(WebAssembly.validate(compilerBytes), 'invalid compiler Wasm');
  const module = new WebAssembly.Module(compilerBytes);
  assert.deepEqual(WebAssembly.Module.imports(module), [], 'compiler must have no imports');
  const api = new WebAssembly.Instance(module, {}).exports;
  assert.ok(api.memory instanceof WebAssembly.Memory, 'compiler memory export required');
  assert.ok(api.memory.buffer.byteLength <= 64 * 1024 * 1024, 'initial memory exceeds 64 MiB');
  for (const name of ['abi_version','input_ptr','input_capacity','compile','result_ptr',
    'result_length','error_ptr','error_line_number','error_column_number']) {
    assert.equal(typeof api[name], 'function', 'missing compiler ABI export: ' + name);
  }
  assert.equal(api.abi_version(), CONTRACT.compilerAbi, 'incompatible compiler ABI');
  const cap = bounded(api.input_capacity(), 65536, 'source capacity');
  assert.ok(cap > 0);
  function compile(source) {
    const data = encoder.encode(source);
    assert.ok(data.length <= cap, 'source exceeds compiler capacity');
    const before = new Uint8Array(api.memory.buffer);
    const ptr = bounded(api.input_ptr(), before.length, 'input pointer');
    assert.ok(ptr + data.length <= before.length, 'input outside compiler memory');
    before.set(data, ptr);
    const status = api.compile(data.length);
    if (status !== 0) {
      assert.equal(api.result_length(), 0, 'rejection published guest Wasm');
      const bytes = new Uint8Array(api.memory.buffer);
      const at = bounded(api.error_ptr(), bytes.length - 1, 'diagnostic pointer');
      let end = at;
      while (end < bytes.length && end - at < 512 && bytes[end] !== 0) end++;
      assert.ok(end < bytes.length && end - at < 512, 'unterminated diagnostic');
      assert.ok(api.error_line_number() >= 1 && api.error_column_number() >= 1,
        'diagnostic must have line and column');
      return {ok: false, code: decoder.decode(bytes.subarray(at, end)).split(':')[0]};
    }
    const bytes = new Uint8Array(api.memory.buffer);
    const at = bounded(api.result_ptr(), bytes.length, 'guest pointer');
    const n = bounded(api.result_length(), 1024 * 1024, 'guest length');
    assert.ok(n >= 8 && at + n <= bytes.length, 'guest outside compiler memory');
    const guest = bytes.slice(at, at + n);
    assert.ok(WebAssembly.validate(guest), 'compiler emitted invalid guest');
    return {ok: true, guest};
  }

  const sample = decoder.decode(sampleBytes);
  const good = compile(sample);
  assert.ok(good.ok, 'reviewed site example rejected');
  const gm = new WebAssembly.Module(good.guest);
  assert.deepEqual(WebAssembly.Module.imports(gm), [], 'example guest requires unexpected host imports');
  assert.ok(WebAssembly.Module.exports(gm).some(x => x.name === 'main' && x.kind === 'function'));
  assert.ok(WebAssembly.Module.exports(gm).every(x => ['main','memory','panic_code'].includes(x.name)));
  const value = new WebAssembly.Instance(gm, {}).exports.main();
  assert.equal(value, CONTRACT.expectedMain, 'example must yield 84');
  const again = compile(sample);
  assert.ok(again.ok && sha256(again.guest) === sha256(good.guest), 'compiler nondeterministic');
  const mutate = (a, b) => {
    assert.equal(sample.split(a).length - 1, 1, 'not an exact mutation point');
    return sample.replace(a,b);
  };
  const negativeCases = [
    ['mutable_capture', mutate('val captured_factor = factor;', 'let captured_factor = factor;'), 'E_CAPTURE'],
    ['nested_capture_shadow', mutate('  return triple(14); // 42',
      '  if true then val captured_factor = 99; return triple(14); fi\n  return triple(14); // 42'), 'E_CAPTURE'],
    ['escaped_closure', 'fnc make_multiplier(int f): fnc(int)->int { return |n| : int -> n * f; }\n' +
      'pub fnc main(): int { return 0; }', 'E_UNSUPPORTED']
  ];
  for (const [name, mutated, expected] of negativeCases) {
    const bad = compile(mutated);
    assert.equal(bad.ok, false, name + ' was admitted');
    assert.equal(bad.code, expected, name + ' changed diagnostic');
    assert.ok(compile('pub fnc main(): int { return 42; }').ok, name + ' poisoned compiler');
  }
  return {
    status:'PASS_CANDIDATE_ONLY', published:false, sourceHead, sourceTree,
    candidateSha256, sampleGitBlob: CONTRACT.siteExampleBlob,
    guestSha256:sha256(good.guest), guestResult:String(value),
    rejected:negativeCases.map(x=>[x[0],x[2]]),
    warning:'not an independent release approval; first-class escaped closures unsupported'
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 7) {
    throw new Error('Usage: node scripts/verify-closures-functors-wasm.mjs <candidate.wasm> <site-example.atto> <candidate-sha256> <source-head> <source-tree>');
  }
  const [compilerPath, samplePath, candidateSha256, sourceHead, sourceTree] = process.argv.slice(2);
  console.log(JSON.stringify(verifyAndRun({
    compilerBytes:readFileSync(compilerPath),
    sampleBytes:readFileSync(samplePath), candidateSha256, sourceHead, sourceTree
  }), null, 2));
}
