import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const corpusUrl = new URL('../contracts/atto-xo-checked-debit-v1/cases.tsv', import.meta.url);
const corpusSha = 'e6e3394d5d62ec1f8171053b74a3b68389c41d5c797d81c14f561d1ca097a28b';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const expected = new Map([
  ['normal', '42'], ['control', '43'], ['max-valid', '42'],
  ['fee-overflow', 'overflow'], ['notional-overflow', 'overflow'],
  ['overflow-cancel', 'overflow'], ['overflow-dead-result', 'overflow']
]);

function readCorpus(bytes) {
  assert.equal(digest(bytes), corpusSha, 'shared corpus SHA-256 mismatch');
  const rows = bytes.toString('utf8').trimEnd().split('\n');
  assert.equal(rows.length, expected.size);
  const seen = new Set();
  return rows.map(row => {
    const fields = row.split('|');
    assert.equal(fields.length, 8);
    const [id, outcome, , , , , , source] = fields;
    assert.ok(expected.has(id) && !seen.has(id), 'unexpected or repeated case');
    assert.equal(outcome, expected.get(id), id);
    seen.add(id);
    return { id, outcome, source };
  });
}

function observe(moduleBytes, outcome) {
  const module = new WebAssembly.Module(moduleBytes);
  assert.deepEqual(WebAssembly.Module.imports(module), [], 'scalar guest must be self-contained');
  const instance = new WebAssembly.Instance(module);
  assert.equal(typeof instance.exports.main, 'function', 'missing main');
  if (outcome === 'overflow') {
    assert.throws(() => instance.exports.main(), WebAssembly.RuntimeError);
  } else {
    assert.equal(instance.exports.main(), BigInt(outcome), 'full i64 guest result');
  }
}

test('checked debit corpus identity and mutation detection (host only)', async () => {
  const bytes = await readFile(corpusUrl);
  assert.equal(readCorpus(bytes).length, 7);
  const mutant = Buffer.from(bytes);
  mutant[0] ^= 1;
  assert.throws(() => readCorpus(mutant), /SHA-256 mismatch/);
});

// Small handwritten Wasm modules validate the observer, NOT Atto compilation.
function syntheticModule(resultType, instructions) {
  const body = [0, ...instructions, 0x0b];
  return Uint8Array.from([
    0,97,115,109,1,0,0,0,
    1,5,1,0x60,0,1,resultType,
    3,2,1,0,
    7,8,1,4,109,97,105,110,0,0,
    10,body.length+2,1,body.length,...body
  ]);
}

test('Wasm observer rejects truncation and wrong numeric type (synthetic only)', () => {
  observe(syntheticModule(0x7e, [0x42,42]), '42');
  assert.throws(() => observe(syntheticModule(0x7e, [0x42,0xaa,0x02]), '42'), /full i64/);
  assert.throws(() => observe(syntheticModule(0x7f, [0x41,42]), '42'), /full i64/);
  observe(syntheticModule(0x7e, [0x00]), 'overflow');
  assert.throws(() => observe(syntheticModule(0x7e, [0x42,42]), 'overflow'), /Missing expected exception/);
});

const compiler = process.env.ORESLANG_LLVM_COMPILER;
const required = process.env.ATTO_XO_WASM_PARITY_REQUIRED === '1' ||
  process.env.ORESLANG_SCALAR_PARITY_REQUIRED === '1' ||
  process.env.ORESLANG_REQUIRE_REAL_COMPILER !== undefined;

test('seven exact-source Atto checked debit Wasm guests', {
  skip: !compiler && !required ? 'NOT_EXECUTED: no LLVM compiler configured' : false,
  timeout: 180000
}, async t => {
  assert.ok(compiler, 'required compiler unavailable; skipping is forbidden');
  const compilerSha = process.env.ORESLANG_LLVM_COMPILER_SHA256;
  assert.match(compilerSha ?? '', /^[a-f0-9]{64}$/, 'reviewed compiler binary pin required');
  assert.match(process.env.ORESLANG_LLVM_SOURCE_SHA ?? '', /^[a-f0-9]{40}$/, 'compiler source head pin required');
  const { compileOresToWasm, readBoundedRegularFile } = await import('../scripts/compile-ores.mjs');
  const binary = resolve(compiler);
  assert.equal(digest((await readBoundedRegularFile(binary, 256*1024*1024)).bytes), compilerSha);
  const cases = readCorpus(await readFile(corpusUrl));
  const directory = await mkdtemp(join(tmpdir(), 'atto-xo-wasm-'));
  t.after(() => rm(directory, { recursive:true, force:true }));
  for (const {id, outcome, source} of cases) {
    const input = join(directory, id + '.atto');
    const output = join(directory, id + '.wasm');
    const bytes = Buffer.from(source, 'utf8');
    await writeFile(input, bytes);
    await compileOresToWasm({compiler:binary, compilerSha256:compilerSha, source:input, output});
    assert.deepEqual(await readFile(input), bytes, id + ': compiler altered source');
    observe(await readFile(output), outcome);
    t.diagnostic(id + ': ' + outcome);
  }
  assert.equal(digest((await readBoundedRegularFile(binary, 256*1024*1024)).bytes), compilerSha);
  assert.equal(digest(await readFile(corpusUrl)), corpusSha);
});
