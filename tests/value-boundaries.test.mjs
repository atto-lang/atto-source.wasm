import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, writeFile, rm, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compileOresToWasm} from '../scripts/compile-ores.mjs';

const cases = JSON.parse(await readFile(new URL('./value-boundary-rejections.json', import.meta.url)));
test('real source value boundaries reject before publishing a Wasm artifact', {
  skip: !process.env.ORESLANG_LLVM_COMPILER,
  timeout: 60000
}, async () => {
  const compiler = process.env.ORESLANG_LLVM_COMPILER;
  const compilerSha256 = createHash('sha256').update(await readFile(compiler)).digest('hex');
  if (process.env.ORESLANG_LLVM_COMPILER_SHA256) {
    assert.equal(compilerSha256, process.env.ORESLANG_LLVM_COMPILER_SHA256);
  }
  const dir = await mkdtemp(join(tmpdir(), 'ores-value-boundaries-'));
  try {
    const source = join(dir, 'main.ores');
    const output = join(dir, 'good.wasm');
    await writeFile(source, 'pub fnc main():int{return (5+3)*7-14;}');
    await compileOresToWasm({compiler, compilerSha256, source, output});
    const good = await readFile(output);
    assert.equal(new WebAssembly.Instance(new WebAssembly.Module(good)).exports.main(), 42n);
    const provenance = await readFile(output + '.provenance.json');
    const originalEntries = (await readdir(dir)).sort();
    assert.equal(Object.keys(cases).length, 15);
    for (const [name, program] of Object.entries(cases)) {
      await writeFile(source, program);
      // Exercise both failure with no previous output and preservation of a
      // previous successful artifact. A toolchain failure alone is no pass.
      for (const target of [join(dir, 'rejected.wasm'), output]) {
        await assert.rejects(
          compileOresToWasm({compiler, compilerSha256, source, output: target}),
          error => /command failed/.test(error.message) && /oreslang-llvmc:/.test(error.message), name);
      }
      assert.deepEqual(await readFile(output), good, name + ': replaced valid module');
      assert.deepEqual(await readFile(output + '.provenance.json'), provenance, name + ': replaced provenance');
      assert.deepEqual((await readdir(dir)).sort(), originalEntries, name + ': published rejected artifact');
    }
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
