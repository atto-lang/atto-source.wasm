// Real LLVM-to-Wasm guest execution is required for parity credit.
// No compiler => explicit skip; strict mode => fail; no host arithmetic oracle substitution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { compileOresToWasm } from '../scripts/compile-ores.mjs';

const vectors = JSON.parse(readFileSync(new URL('../contracts/oresllm-parity/v1/budget-extension.json', import.meta.url), 'utf8'));
const compiler = process.env.ORESLANG_LLVM_COMPILER;
const compilerSha256 = process.env.ORESLLM_LLVM_COMPILER_SHA256;
const required = process.env.ORESLLM_REQUIRE_REAL_WASM_PARITY === '1';

async function fixture(t, expression, callback) {
  if (!compiler) {
    if (required) throw Error('real Wasm budget parity requires pinned ORESLANG_LLVM_COMPILER');
    t.skip('no compiler configured: authored source does not prove guest execution');
    return;
  }
  if (!/^[0-9a-f]{64}$/.test(compilerSha256 || ''))
    throw Error('real Wasm budget parity requires ORESLLM_LLVM_COMPILER_SHA256');
  const directory = await mkdtemp(join(tmpdir(), 'oresllm-budget-wasm-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'input.ores');
  const output = join(directory, 'result.wasm');
  await writeFile(source, '// oreslang:checked-i64-v1\ndefine pub fnc main(): int { return ' + expression + '; }\n', { flag: 'wx' });
  await callback({ source, output, compiler: resolve(compiler), compilerSha256 });
}

async function smokeCompiler(options, directory) {
  // A rejection alone could be caused by broken compiler/toolchain admission.
  // First verify that this exact compiler can compile and execute a valid guest.
  const source = join(directory, 'smoke.ores');
  const output = join(directory, 'smoke.wasm');
  await writeFile(source, '// oreslang:checked-i64-v1\ndefine pub fnc main(): int { return 42; }\n', { flag: 'wx' });
  await compileOresToWasm({ ...options, source, output });
  const { instance } = await WebAssembly.instantiate(await readFile(output), {});
  assert.equal(instance.exports.main(), 42n, 'real WASM compiler smoke must execute');
}

for (const vector of vectors.positive) {
  test('real Wasm budget positive ' + vector.id, async t => fixture(t, vector.expression, async options => {
    await compileOresToWasm(options);
    const { instance } = await WebAssembly.instantiate(await readFile(options.output), {});
    assert.equal(instance.exports.main(), BigInt(vector.expected_i64));
  }));
}

for (const vector of vectors.checked_overflow) {
  test('real Wasm budget checked overflow ' + vector.id, async t => fixture(t, vector.expression, async options => {
    await smokeCompiler(options, join(options.source, '..'));
    await compileOresToWasm(options);
    const { instance } = await WebAssembly.instantiate(await readFile(options.output), {});
    assert.throws(() => instance.exports.main(), WebAssembly.RuntimeError);
  }));
}

for (const vector of vectors.compile_reject) {
  test('real Wasm budget compile rejection ' + vector.id, async t => fixture(t, vector.expression, async options => {
    await smokeCompiler(options, join(options.source, '..'));
    await assert.rejects(() => compileOresToWasm(options));
  }));
}

test('Wasm budget proof never auto-passes without compiler and digest', t => {
  if (compiler) {
    assert.match(compilerSha256 || '', /^[0-9a-f]{64}$/, 'missing pinned binary SHA-256');
  } else if (required) {
    assert.fail('strict real-Wasm budget parity requested but compiler is absent');
  } else {
    t.skip('no compiler: this is not backend parity evidence');
  }
});
