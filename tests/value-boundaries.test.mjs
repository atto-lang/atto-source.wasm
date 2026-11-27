import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, writeFile, rm, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compileOresToWasm, readBoundedRegularFile} from '../scripts/compile-ores.mjs';

const legacyCases = JSON.parse(await readFile(new URL('./value-boundary-rejections.json', import.meta.url)));
const sharedCases = JSON.parse(await readFile(
  new URL('../contracts/v1/cpu-gpu-nb-unsupported-v1.json', import.meta.url)));
const taskV2Cases = JSON.parse(await readFile(
  new URL('../contracts/v2/cpu-gpu-task-unsupported-v2.json', import.meta.url)));
const sharedKeys = Object.keys(sharedCases);
assert.equal(sharedKeys.length, 10, 'the shared ten-case source contract must remain complete');
assert.equal(new Set(sharedKeys).size, 10, 'no duplicate CPU/GPU/nb case IDs');
for (const [name, source] of Object.entries(sharedCases)) {
  assert.match(source, /^pub fnc main\(\):int\{return (?:nb )?(?:cpu|gpu)\s*\{/,
    name + ': exact-source region fixture required');
}
assert.equal(Object.keys(legacyCases).filter(k => Object.hasOwn(sharedCases, k)).length, 0,
  'shared fixtures must not be overwritten by older local corpus');
assert.equal(Object.keys(taskV2Cases).length, 10, 'CPU/GPU task v2 corpus must remain complete');
assert.equal(new Set(Object.keys(taskV2Cases)).size, 10, 'no duplicate CPU/GPU task v2 case IDs');
// The v1 and v2 contracts may both pin a case, but one ID must name one source.
assert.equal(Object.keys(taskV2Cases).filter(k =>
  (Object.hasOwn(sharedCases, k) && sharedCases[k] !== taskV2Cases[k]) ||
  (Object.hasOwn(legacyCases, k) && legacyCases[k] !== taskV2Cases[k])).length, 0,
  'v2 task fixtures must not reuse a stable ID for different source');
for (const [name, source] of Object.entries(taskV2Cases)) {
  assert.match(source, /^pub fnc main\(\):(?:int|void)\{/,
    name + ': exact-source v2 fixture required');
}
// These are not proof of borrow-capable Wasm Tasks: they assert that a pinned
// native compiler rejects unlowered captures before any guest artifact exists.
const borrowTaskCases = Object.freeze({
  'task-borrow-shared': 'pub fnc main(int owner):int{return task { return rt borrow owner; };}',
  'task-borrow-mut': 'pub fnc main(int owner):int{return task { return rt mut borrow owner; };}',
  'task-borrow-nested': 'pub fnc main(int owner):int{return task { return task { return rt borrow owner; }; };}',
  'task-borrow-comment': 'pub fnc main(int owner):int{return task /* comment */ { return rt borrow owner; };}',
  'task-borrow-statement': 'pub fnc main(int owner):int{return task { rt borrow owner; return 1; };}',
  'task-borrow-classic-for-init': 'pub fnc main(int owner):int{return task { for (val loop = rt borrow owner; false; ) {} return 0; };}'
});
assert.equal(Object.keys(borrowTaskCases).length, 6);
for (const source of Object.values(borrowTaskCases))
  assert.match(source, /task[\s\S]*\{[\s\S]*rt (?:mut )?borrow/, 'must exercise a captured borrow inside Task');

const cases = {...legacyCases, ...sharedCases, ...taskV2Cases, ...borrowTaskCases};
test('real source value boundaries reject before publishing a Wasm artifact', {
  // A baseline unit suite can omit the optional installed native compiler;
  // a real-parity CI job must opt in and cannot silently skip when missing.
  skip: !process.env.ORESLANG_LLVM_COMPILER &&
        process.env.ORESLANG_REQUIRE_REAL_COMPILER === undefined,
  timeout: 60000
}, async () => {
  const compiler = process.env.ORESLANG_LLVM_COMPILER;
  assert.ok(compiler,
    'ORESLANG_REQUIRE_REAL_COMPILER requires ORESLANG_LLVM_COMPILER; never skip required guest execution');
  // A real-compiler parity run is never an implicit unpinned test. Require
  // both the exact compiled executable and declared upstream source revision.
  // The separate trusted build must independently attest their relationship.
  assert.match(process.env.ORESLANG_LLVM_COMPILER_SHA256 || '', /^[0-9a-f]{64}$/,
    'real compiler parity requires an explicit binary SHA-256 pin');
  assert.match(process.env.ORESLANG_LLVM_SOURCE_SHA || '', /^[0-9a-f]{40}$/,
    'real compiler parity requires an explicit LLVM source commit');
  const bytes = (await readBoundedRegularFile(compiler, 256 * 1024 * 1024)).bytes;
  const compilerSha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(compilerSha256, process.env.ORESLANG_LLVM_COMPILER_SHA256,
    'native Oreslang compiler binary does not match pinned source build');
  const dir = await mkdtemp(join(tmpdir(), 'ores-value-boundaries-'));
  try {
    const source = join(dir, 'main.ores');
    const output = join(dir, 'good.wasm');
    // Real executed positive control uses exactly the normative Java/LLVM Oreslang bytes.
    await writeFile(source, await readFile(new URL('../contracts/v1/semantics/fixtures/add.ores', import.meta.url)));
    await compileOresToWasm({compiler, compilerSha256, source, output});
    const good = await readFile(output);
    assert.equal(new WebAssembly.Instance(new WebAssembly.Module(good)).exports.main(), 42n);
    const provenance = await readFile(output + '.provenance.json');
    // Second independent canonical Java/LLVM scalar program; a guest which
    // merely returns 42 cannot satisfy parenthesized precedence parity.
    const precedenceSource = await readFile(
      new URL('../contracts/v1/semantics/fixtures/precedence.ores', import.meta.url));
    const blobHeader = Buffer.from(`blob ${precedenceSource.length}\0`);
    assert.equal(createHash('sha1').update(blobHeader).update(precedenceSource).digest('hex'),
      '2d09e697ad4eeac4ee263c3656b92998c67f0bfc',
      'shared precedence source differs from canonical Java/LLVM Git blob');
    await writeFile(source, precedenceSource);
    const precedenceOutput = join(dir, 'precedence.wasm');
    await compileOresToWasm({compiler, compilerSha256, source, output: precedenceOutput});
    const precedenceModule = await readFile(precedenceOutput);
    assert.equal(new WebAssembly.Instance(new WebAssembly.Module(precedenceModule)).exports.main(), 40n,
      'actual Wasm guest must compute (2 + 3) * 8 = 40');
    assert.deepEqual(await readFile(output), good, 'precedence compile replaced earlier add artifact');
    assert.deepEqual(await readFile(output + '.provenance.json'), provenance,
      'precedence compile replaced add provenance');
    // Use a byte-pinned native compiler snapshot for direct source denial.
    const stagedCompiler = join(dir, 'compiler-exact');
    await writeFile(stagedCompiler, bytes, {flag:'wx',mode:0o500});
    const originalEntries = (await readdir(dir)).sort();
    // The v1/v2 manifests deliberately share exactly one byte-identical ID.
    // Assert the overlap rather than silently dropping a distinct fixture.
    const sharedIds = Object.keys(taskV2Cases).filter(k => Object.hasOwn(sharedCases, k));
    assert.deepEqual(sharedIds, ['gpu-cpu-gpu-nested']);
    assert.equal(taskV2Cases[sharedIds[0]], sharedCases[sharedIds[0]]);
    assert.equal(Object.keys(legacyCases).length, 20);
    assert.equal(Object.keys(cases).length, 45);
    for (const [name, program] of Object.entries(cases)) {
      await writeFile(source, program);
      const borrowedTask = Object.hasOwn(borrowTaskCases, name);
      if (borrowedTask) {
        const denial = spawnSync(stagedCompiler,
          ['--tree-shake','--tree-shake-root=main','--target=wasm32',source],
          {encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024});
        assert.ifError(denial.error);
        assert.equal(denial.signal,null,name);
        assert.equal(denial.status,1,name);
        assert.equal(denial.stdout,'',name);
        assert.match(denial.stderr,/oreslang-llvmc:.*native execution task lowering unsupported/,name);
        assert.doesNotMatch(denial.stderr,/segmentation fault|internal compiler error|LLVM ERROR|core dumped/i,name);
        assert.equal(createHash('sha256').update(await readFile(stagedCompiler)).digest('hex'),compilerSha256,name);
      }
      // Exercise both failure with no previous output and preservation of a
      // previous successful artifact. A toolchain failure alone is no pass.
      for (const target of [join(dir, 'rejected.wasm'), output]) {
        await assert.rejects(
          compileOresToWasm({compiler, compilerSha256, source, output: target}),
          error => borrowedTask
            ? /^wasm heap loan\/transfer lowering unsupported at byte [0-9]+$/.test(error.message)
            : /command failed/.test(error.message) && /oreslang-llvmc:/.test(error.message), name);
      }
      assert.deepEqual(await readFile(output), good, name + ': replaced valid module');
      assert.deepEqual(await readFile(output + '.provenance.json'), provenance, name + ': replaced provenance');
      assert.deepEqual((await readdir(dir)).sort(), originalEntries, name + ': published rejected artifact');
    }
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
