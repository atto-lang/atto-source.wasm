import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, writeFile, rm, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compileOresToWasm} from '../scripts/compile-ores.mjs';

const cases = JSON.parse(await readFile(
  new URL('./elm-composition-rejections.json', import.meta.url), 'utf8'));

test('composition admission corpus has explicit snake_case and distinct families', () => {
  assert.deepEqual(Object.keys(cases).sort(), [
    'channel-observable-no-implicit-bridge', 'future-and-then',
    'observable-filter-map', 'option-flat-map', 'panic-supervisor',
    'postfix-option-return', 'postfix-result-return',
    'postfix-try-catch-throw', 'raise-bypasses-catch',
    'postfix-future-without-await', 'postfix-option-to-result',
    'postfix-result-error-mismatch', 'postfix-result-scalar-throws',
    'postfix-result-to-option',
    'result-map-err', 'stream-filter-map'
  ]);
  for (const [name, source] of Object.entries(cases)) {
    assert.match(name, /^[a-z]+(?:-[a-z]+)*$/);
    assert.match(source, /pub fnc main\(\):\s*int/);
    assert.doesNotMatch(source, /\.flatMap\(|\.onSuccess\(/);
  }
});

test('real native compiler must reject unsupported reactive composition without altering Wasm release', {
  skip: !process.env.ORESLANG_LLVM_COMPILER,
  timeout: 120000
}, async () => {
  const compiler = process.env.ORESLANG_LLVM_COMPILER;
  const compilerSha256 = createHash('sha256').update(await readFile(compiler)).digest('hex');
  if (process.env.ORESLANG_LLVM_COMPILER_SHA256)
    assert.equal(compilerSha256, process.env.ORESLANG_LLVM_COMPILER_SHA256);
  const dir = await mkdtemp(join(tmpdir(), 'ores-elm-wasm-'));
  try {
    const source = join(dir, 'program.ores');
    const artifact = join(dir, 'valid.wasm');
    await writeFile(source, 'pub fnc main():int{return (5+3)*7-14;}', 'utf8');
    await compileOresToWasm({compiler, compilerSha256, source, output: artifact});
    const valid = await readFile(artifact);
    assert.equal(new WebAssembly.Instance(new WebAssembly.Module(valid)).exports.main(), 42n);
    const provenance = await readFile(artifact + '.provenance.json');
    const baseline = (await readdir(dir)).sort();
    for (const [name, program] of Object.entries(cases)) {
      await writeFile(source, program, 'utf8');
      await assert.rejects(
        compileOresToWasm({compiler, compilerSha256, source, output: artifact}),
        e => /command failed/.test(e.message) && /oreslang-llvmc:/.test(e.message),
        name
      );
      assert.deepEqual(await readFile(artifact), valid, name + ': replaced admitted artifact');
      assert.deepEqual(await readFile(artifact + '.provenance.json'), provenance,
        name + ': replaced valid provenance');
      assert.deepEqual((await readdir(dir)).sort(), baseline,
        name + ': left rejected publication files');
    }
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
