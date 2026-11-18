import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../contracts/attoxp-scalar-v1/', import.meta.url);
const expected = Object.freeze([
  ['answer-42.atto', 42, '08a415734e9992f47702dc9b1ccf2c5dceb74df05245eaa5fbb00512d18afc8a'],
  ['decrement-41.atto', 41, '90da332e7fb4e13443a7c6f741e03d872c8d0422359842f9291326c3c98e1fdf'],
  ['reset-zero.atto', 0, 'c26a72daa25e2d8da6ce0f5b8e1373c444db82537b74da9f687f43307277d6cf'],
  ['multiply-42.atto', 42, 'e07b8ff18f11896a087db1c608d5206df1e36832f5ae6f4b2f8cc505338e342f']
]);
const digest = b => createHash('sha256').update(b).digest('hex');

test('AttoXP pinned source identity and matrix shape (host-only)', async () => {
  const manifest = JSON.parse(await readFile(new URL('cases.json', root), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.contract, 'attolang.attoxp.scalar-parity/1');
  assert.equal(manifest.truth, 'SCALAR_ONLY_NOT_UI_ABI_OR_ACTOR');
  assert.equal(manifest.cases.length, expected.length);
  assert.deepEqual(new Set(manifest.cases.map(c => c.file)).size, expected.length);
  for (let i = 0; i < expected.length; i++) {
    const [file, value, sha] = expected[i];
    const row = manifest.cases[i];
    assert.equal(row.file, file);
    assert.equal(row.id, file.slice(0, -5));
    assert.equal(row.expectedExit, value);
    assert.equal(row.sha256, sha);
    const source = await readFile(new URL(file, root));
    assert.ok(source.length > 0 && source.length <= 4096);
    assert.equal(digest(source), sha, file + ': wrong byte-exact source');
    const mutation = Buffer.from(source); mutation[0] ^= 1;
    assert.notEqual(digest(mutation), sha, file + ': mutation must fail');
  }
});

test('AttoXP four compiler-produced scalar guests execute in Wasm (opt-in, NEVER silent in required CI)', {
  skip: !process.env.ORESLANG_LLVM_COMPILER &&
        process.env.ORESLANG_REQUIRE_REAL_COMPILER === undefined,
  timeout: 120000
}, async () => {
  const binary = process.env.ORESLANG_LLVM_COMPILER;
  assert.ok(binary,
    'ORESLANG_REQUIRE_REAL_COMPILER requires ORESLANG_LLVM_COMPILER; cannot skip Wasm guest');
  assert.match(process.env.ORESLANG_LLVM_COMPILER_SHA256 || '', /^[0-9a-f]{64}$/,
    'exact LLVM compiler binary SHA required');
  assert.match(process.env.ORESLANG_LLVM_SOURCE_SHA || '', /^[0-9a-f]{40}$/,
    'exact LLVM compiler source head required');
  const { compileOresToWasm, readBoundedRegularFile } = await import('../scripts/compile-ores.mjs');
  const binaryInfo = await readBoundedRegularFile(binary, 256 * 1024 * 1024);
  assert.equal(digest(binaryInfo.bytes), process.env.ORESLANG_LLVM_COMPILER_SHA256,
    'compiler binary differs from declared pin');
  const directory = await mkdtemp(join(tmpdir(), 'attoxp-wasm-'));
  try {
    for (const [name, value, sha] of expected) {
      const source = fileURLToPath(new URL(name, root));
      assert.equal(digest(await readFile(source)), sha, 'fixture mutated before compiler');
      const output = join(directory, name + '.wasm');
      await compileOresToWasm({
        compiler: binary, compilerSha256: process.env.ORESLANG_LLVM_COMPILER_SHA256,
        source, output
      });
      const wasm = await readFile(output);
      const module = new WebAssembly.Module(wasm);
      const instance = new WebAssembly.Instance(module);
      assert.equal(typeof instance.exports.main, 'function', 'missing wasm main export');
      assert.equal(BigInt(instance.exports.main()), BigInt(value),
        name + ': actual Wasm guest result mismatch');
      assert.equal(digest(await readFile(source)), sha, 'fixture mutated after compiler');
    }
  } finally {
    await rm(directory, {recursive:true, force:true});
  }
});
