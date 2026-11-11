// Candidate real-compiler integration: LLVM .atto -> Wasm32 -> isolated execution.
// Ordinary Node WebAssembly execution is NOT proof of strict no-JIT runtime AOT.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { compileOresToWasm, readBoundedRegularFile } from '../scripts/compile-ores.mjs';
import { readAtomicRelease } from '../scripts/atomic-release.mjs';
import { runIsolatedCoreGuest } from '../src/isolated-runner.mjs';

const ORACLES = Object.freeze([
  { id: 'neq-alias-true', kind: 'execute', value: 42n, gitBlob: '35cd5e58c6a5abc4f3ccb231cdb6a620402da6ef' },
  { id: 'neq-alias-false', kind: 'execute', value: 37n, gitBlob: '863fb69b5d344002239f24239d2f7cdabdbcbf3d' },
  { id: 'neq-alias-mixed-reject', kind: 'reject', diagnostic: 'equality operands require the same scalar type', gitBlob: '93fb9b3ca5593edf9c0600a75486b840665bec13' },
  { id: 'neq-alias-split-reject', kind: 'reject', diagnostic: 'expected', gitBlob: '8360d632a28bbf5eb3e2425d8d81d07dd892dae4' }
]);
// This gate is tied to the EXACT LLVM #1658 PR head/tree. Changing either
// requires a reviewed companion test update; an arbitrary 40-hex claim is not
// evidence that the correct native compiler produced the module.
const EXPECTED_LLVM = Object.freeze({
  head: 'e93035450d000ad8144b718a0f353a091ab6e5d2',
  tree: 'f799bf5917c78fa3ea80d14ae4e159da1ac12496'
});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const gitBlob = bytes => createHash('sha1')
  .update(Buffer.from('blob ' + bytes.length + '\0', 'ascii')).update(bytes).digest('hex');

async function fixture(item) {
  const bytes = await readFile(new URL('./fixtures/erl-otp-aot/' + item.id + '.atto', import.meta.url));
  assert.ok(bytes.length > 50 && bytes.length < 8192, 'AttoLang source size');
  assert.equal(gitBlob(bytes), item.gitBlob, item.id + ' has changed without review');
  assert.match(bytes.toString('utf8'), /7 !eq (?:8|7|true)|7 ! eq 8/);
  return bytes;
}

function admission(env) {
  if (!env.ORESLANG_LLVM_COMPILER || !isAbsolute(env.ORESLANG_LLVM_COMPILER))
    throw Error('absolute approved native LLVM compiler required');
  if (!/^[0-9a-f]{64}$/.test(env.ORESLANG_LLVM_COMPILER_SHA256 || ''))
    throw Error('LLVM compiler executable SHA256 required');
  if (!/^[0-9a-f]{40}$/.test(env.ORESLANG_LLVM_SOURCE_SHA || '') ||
      !/^[0-9a-f]{40}$/.test(env.ORESLANG_LLVM_SOURCE_TREE || ''))
    throw Error('LLVM compiler source head and tree required');
  if (env.ORESLANG_LLVM_SOURCE_SHA !== EXPECTED_LLVM.head ||
      env.ORESLANG_LLVM_SOURCE_TREE !== EXPECTED_LLVM.tree)
    throw Error('LLVM compiler source does not match reviewed exact PR #1658 head/tree');
  return { compiler: env.ORESLANG_LLVM_COMPILER, pin: env.ORESLANG_LLVM_COMPILER_SHA256,
    sha: env.ORESLANG_LLVM_SOURCE_SHA, tree: env.ORESLANG_LLVM_SOURCE_TREE };
}

test('AttoLang inequality Wasm corpus is exact source-only inventory', async () => {
  assert.equal(ORACLES.length, 4);
  for (const item of ORACLES) await fixture(item);
  assert.deepEqual(ORACLES.filter(x => x.kind === 'execute').map(x => x.value), [42n, 37n]);
  assert.deepEqual(ORACLES.filter(x => x.kind === 'reject').map(x => x.id),
    ['neq-alias-mixed-reject', 'neq-alias-split-reject']);
});

test('real compiler admission fails closed with missing SHA or source tree', () => {
  assert.throws(() => admission({}), /absolute approved native LLVM compiler/);
  assert.throws(() => admission({ORESLANG_LLVM_COMPILER: '/missing'}), /executable SHA256/);
  assert.throws(() => admission({ORESLANG_LLVM_COMPILER: '/missing',
    ORESLANG_LLVM_COMPILER_SHA256: 'a'.repeat(64)}), /source head and tree/);
  const candidate = {
    ORESLANG_LLVM_COMPILER: '/missing',
    ORESLANG_LLVM_COMPILER_SHA256: 'a'.repeat(64),
    ORESLANG_LLVM_SOURCE_SHA: EXPECTED_LLVM.head,
    ORESLANG_LLVM_SOURCE_TREE: EXPECTED_LLVM.tree
  };
  assert.deepEqual(admission(candidate).sha, EXPECTED_LLVM.head);
  assert.throws(() => admission({...candidate,
    ORESLANG_LLVM_SOURCE_SHA: 'b'.repeat(40)}), /reviewed exact PR/);
  assert.throws(() => admission({...candidate,
    ORESLANG_LLVM_SOURCE_TREE: 'c'.repeat(40)}), /reviewed exact PR/);
  assert.throws(() => admission({...candidate,
    ORESLANG_LLVM_SOURCE_SHA: EXPECTED_LLVM.tree,
    ORESLANG_LLVM_SOURCE_TREE: EXPECTED_LLVM.head}), /reviewed exact PR/);
});

// A real binary and source provenance must be provided; otherwise skip, never
// promote a source-only gate to compiler-guest evidence.
const demand = process.env.ATTO_WASM_NEQ_REQUIRED || '0';
if (!['0', '1'].includes(demand)) throw Error('ATTO_WASM_NEQ_REQUIRED must be 0 or 1');
const configured = Boolean(process.env.ORESLANG_LLVM_COMPILER);
test('real compiler builds and executes !eq Wasm guest and rejects unsafe inputs', {
  skip: !configured && demand !== '1', timeout: 180000
}, async () => {
  const { compiler, pin, sha, tree } = admission(process.env);
  const binary = await readBoundedRegularFile(compiler, 256 * 1024 * 1024,
    'missing or oversized LLVM compiler');
  assert.equal(digest(binary.bytes), pin, 'binary does not match declared digest');
  assert.equal(sha, EXPECTED_LLVM.head);
  assert.equal(tree, EXPECTED_LLVM.tree);
  // These env values remain self-reported; independently reviewed checkout
  // attestation plus compiler binary build provenance is a separate gate.
  const directory = await mkdtemp(join(tmpdir(), 'atto-wasm-neq-'));
  try {
    let executed = 0;
    let rejected = 0;
    for (const item of ORACLES) {
      const bytes = await fixture(item);
      const source = join(directory, item.id + '.atto');
      const output = join(directory, item.id + '.wasm');
      await writeFile(source, bytes, { flag: 'wx', mode: 0o400 });
      const compile = () => compileOresToWasm({
        compiler, compilerSha256: pin, source, output,
        environment: 'browser', publication: 'atomic'
      });
      if (item.kind === 'reject') {
        await assert.rejects(compile, e =>
          String(e?.message || e).includes(item.diagnostic),
          item.id + ' should be rejected by the LLVM compiler for the right reason');
        await assert.rejects(stat(output), { code: 'ENOENT' }, item.id + ' published rejected Wasm');
        await assert.rejects(stat(output + '.current.json'), { code: 'ENOENT' });
        rejected++;
      } else {
        const compiled = await compile();
        assert.equal(compiled.sourceSha256, digest(bytes));
        assert.equal(compiled.compilerSha256, pin);
        const release = await readAtomicRelease(output);
        assert.equal(release.manifest.wasmSha256, compiled.wasmSha256);
        assert.equal(digest(release.wasm), compiled.wasmSha256);
        assert.deepEqual(release.manifest.imports, []);
        assert.deepEqual(release.manifest.requiredCapabilities, []);
        const result = await runIsolatedCoreGuest(release.wasm, {
          expectedSha256: compiled.wasmSha256, timeoutMs: 5000
        });
        assert.equal(result.value, item.value, item.id + ' real guest result');
        assert.equal(result.admission.imports, 0);
        assert.equal(result.admission.hostCapabilities, 0);
        executed++;
      }
    }
    assert.equal(executed, 2);
    assert.equal(rejected, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
