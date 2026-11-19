// Offline, fail-closed consistency check for a claimed compiled bool Wasm run.
// Input JSON and artifact metadata are UNTRUSTED; independent GitHub API and
// source-tree attestation remain required. This never certifies Java/AOT parity.
import assert from 'node:assert/strict';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';

export const BOOLEAN_CASES = Object.freeze([
  ['literal-not', 'execute', '42', 'b241dc1838f88e55c1e54e1774d0863fba4c8011'],
  ['typed-let', 'execute', '42', '1a4871aa1ab5ff56eba1888fec3b4c796871f62c'],
  ['nested-call', 'execute', '42', '7c2e1e3e1f68353964c8d2c3dedca553399f8d77'],
  ['bool-guarded-result', 'execute', '42', 'a058972b4b41dc13338822e872477d362b6a2973'],
  ['false-fallthrough', 'execute', '37', '4f8f74dddc412676f2f21f97debad8ff146b0d9a'],
  ['else-branch', 'execute', '13', 'e1d9a677284cf05c330b0db3bf4c3cf828af60a9'],
  ['bool-as-int', 'reject', 'native function return requires int, got bool', '0211a57f7f8108ca467ff76f3b8c9e6e834178aa'],
  ['truthy-int', 'reject', 'native guarded return condition requires bool, got int', '2f917d5683fc501c282e55bccec1d52a0b2118ba'],
  ['bool-arithmetic', 'reject', 'arithmetic requires int, got bool', '26c4cb3ca196f5d88ed756645138c75841e50e05'],
  ['comparison-type', 'reject', 'equality operands require the same scalar type', '49d6d800fb043bdf06c224c8894ee997087b7ea5'],
  ['not-integer', 'reject', "logical '!' requires bool, got int", 'd3c8dd38ecf218f32b64df8acf785acdfe0309a4'],
]);
const LLVM_HEAD = 'b83f540269a256e549cc9160b6b43bf37d33fb0f';
const LLVM_TREE = '26e85b258061b206e4a145825df6dfe11065a499';
const REFERENCE_BLOB = '80056fbf9d67e3fb37a052652398c2dc3796540b';
const WASM_REPO = 'ores-truffle-oreslang/oreslang-source.wasm';
const LLVM_REPO = 'ores-truffle-oreslang/oreslang-source.llvm';
const requiredSteps = Object.freeze([
  'Require authorized private LLVM read access',
  'Check out Wasm backend',
  'Bind protected Wasm main checkout',
  'Check out immutable private LLVM compiler source',
  'Verify exact LLVM source commit',
  'Compile exact LLVM compiler checkout',
  'Pin actual native compiler binary',
  'Run WebAssembly regression suite',
  'Execute genuine Oreslang-to-Wasm end-to-end gate',
  'Execute mandatory pinned boolean Wasm32 guest and type rejection matrix',
  'Upload source-bound boolean guest evidence (not Java certification)',
]);
const hex40 = /^[0-9a-f]{40}$/;
const hex64 = /^[0-9a-f]{64}$/;
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function requireRecord(v, label) {
  assert.ok(record(v), label + ' must be a JSON object');
  return v;
}
function positive(v) { return Number.isSafeInteger(v) && v > 0; }
function assertStep(job, name) {
  const matches = job.steps.filter(s => s?.name === name);
  assert.equal(matches.length, 1, 'missing/duplicate executed step: ' + name);
  assert.equal(matches[0].status, 'completed', name + ' was not completed');
  assert.equal(matches[0].conclusion, 'success', name + ' did not succeed');
  assert.ok(positive(matches[0].number), name + ' lacks step number');
  assert.ok(matches[0].started_at && matches[0].completed_at,
    name + ' lacks timestamps');
}

export function assessBooleanWasmEvidence({receipt, run, jobs, artifacts, expectedHead, expectedTree}) {
  assert.match(expectedHead ?? '', hex40, 'expected Wasm HEAD is required');
  assert.match(expectedTree ?? '', hex40, 'expected Wasm tree is required');
  requireRecord(receipt, 'receipt');
  requireRecord(run, 'workflow run');
  requireRecord(jobs, 'jobs response');
  requireRecord(artifacts, 'artifacts response');
  assert.equal(receipt.schema, 'atto-boolean-wasm32-guest-evidence-v1');
  assert.equal(receipt.classification,
    'EXECUTED_WASM32_GUEST_AND_NATIVE_FRONTEND_REJECTIONS');
  assert.equal(receipt.wasm?.repository, WASM_REPO);
  assert.equal(receipt.wasm?.head, expectedHead);
  assert.equal(receipt.wasm?.tree, expectedTree);
  assert.equal(receipt.llvm?.repository, LLVM_REPO);
  assert.equal(receipt.llvm?.sourceHeadMetadata, LLVM_HEAD);
  assert.equal(receipt.llvm?.sourceTreeMetadata, LLVM_TREE);
  assert.equal(receipt.llvm?.referenceTestGitBlob, REFERENCE_BLOB);
  assert.match(receipt.llvm?.compilerSha256 ?? '', hex64);
  assert.equal(receipt.executedGuests, 6);
  assert.equal(receipt.nativeFrontendRejections, 5);
  assert.equal(receipt.javaDifferential, 'NOT_EXECUTED');
  assert.equal(receipt.fiveBackendCertification, 'NOT_CERTIFIED');
  assert.ok(Array.isArray(receipt.cases) && receipt.cases.length === BOOLEAN_CASES.length,
    '11 guest cases required');
  const seen = new Set();
  for (let i = 0; i < BOOLEAN_CASES.length; i++) {
    const [id, kind, value, blob] = BOOLEAN_CASES[i];
    const c = requireRecord(receipt.cases[i], 'case ' + id);
    assert.equal(c.id, id, 'fixture order and IDs must match canonical matrix');
    assert.ok(!seen.has(c.id), 'duplicate case');
    seen.add(c.id);
    assert.equal(c.sourceGitBlob, blob, id + ' source blob changed');
    assert.match(c.sourceSha256 ?? '', hex64, id + ' lacks source hash');
    if (kind === 'execute') {
      assert.equal(c.kind, 'EXECUTED_WASM32_GUEST');
      assert.equal(c.expected, value);
      assert.equal(c.observed, value);
      assert.match(c.wasmSha256 ?? '', hex64, id + ' missing Wasm binary hash');
      assert.equal(c.imports, 0);
      assert.equal(c.hostCapabilities, 0);
    } else {
      assert.equal(c.kind, 'NATIVE_LLVM_TYPE_REJECTION');
      assert.equal(c.diagnostic, value, id + ' wrong type diagnostic');
      assert.equal(c.exitStatus, 1);
      assert.equal(c.emittedLLVM, false);
      assert.equal(c.publishedArtifact, false);
    }
  }
  assert.equal(run.repository?.full_name, WASM_REPO);
  assert.ok(positive(run.repository?.id), 'runner repository numeric ID missing');
  assert.equal(run.head_sha, expectedHead);
  assert.equal(run.head_branch, 'main', 'credentialed gate must run on main only');
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.name, 'Real pinned Oreslang LLVM to Wasm gate');
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  assert.ok(positive(run.id) && positive(run.run_attempt), 'missing run ID/attempt');
  assert.ok(typeof run.path === 'string' &&
    ['.github/workflows/real-llvm.yml', 'ores-truffle-oreslang/oreslang-source.wasm/.github/workflows/real-llvm.yml@refs/heads/main'].includes(run.path),
    'untrusted workflow identity/path');
  assert.ok(Array.isArray(jobs.jobs) && jobs.jobs.length === 1,
    'expected exactly one integration job');
  const job = requireRecord(jobs.jobs[0], 'integration job');
  assert.equal(job.run_id, run.id);
  assert.equal(job.name, 'integration');
  assert.equal(job.status, 'completed');
  assert.equal(job.conclusion, 'success');
  assert.ok(positive(job.runner_id) && typeof job.runner_name === 'string' &&
    job.runner_name.length > 0, 'no admitted runner identity');
  assert.ok(job.started_at && job.completed_at, 'job lacks execution interval');
  assert.ok(Array.isArray(job.steps) && job.steps.length >= requiredSteps.length,
    'zero-step or incomplete workflow cannot prove execution');
  for (const name of requiredSteps) assertStep(job, name);
  assert.ok(Array.isArray(artifacts.artifacts) && artifacts.artifacts.length > 0,
    'receipt artifact missing');
  const name = 'boolean-wasm32-guest-evidence-' + run.id + '-' + run.run_attempt;
  const matching = artifacts.artifacts.filter(a => a?.name === name);
  assert.equal(matching.length, 1, 'missing or duplicate exact-run artifact');
  const artifact = matching[0];
  assert.ok(positive(artifact.id) && positive(artifact.size_in_bytes) &&
    artifact.expired === false, 'artifact is empty, expired or unidentifiable');
  assert.equal(artifact.workflow_run?.id, run.id);
  assert.equal(artifact.workflow_run?.head_sha, expectedHead);
  return Object.freeze({
    status: 'CONSISTENT_UNTRUSTED_EXECUTION_RECORDS',
    wasmHead: expectedHead, wasmTree: expectedTree, workflowRunId: run.id,
    workflowRunAttempt: run.run_attempt, compilerSha256: receipt.llvm.compilerSha256,
    checkedGuestCases: 6, checkedRejections: 5,
    javaDifferential: 'NOT_EXECUTED', releaseCertification: 'NOT_CERTIFIED',
    limitation: 'Offline consistency is not authenticated GitHub API provenance; independently inspect run, steps, source checkout and artifact.',
  });
}

async function readBoundedJson(path) {
  if (!path || !isAbsolute(path)) throw Error('input JSON path must be absolute');
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.size <= 0 || before.size > 2 * 1024 * 1024)
      throw Error('evidence JSON exceeds regular-file byte budget');
    const buffer = Buffer.alloc(before.size);
    let at = 0;
    while (at < buffer.length) {
      const {bytesRead} = await fd.read(buffer, at, buffer.length - at, at);
      if (!bytesRead) throw Error('truncated evidence JSON');
      at += bytesRead;
    }
    const after = await fd.stat();
    if (after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs)
      throw Error('evidence JSON changed during snapshot');
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(buffer));
  } finally { await fd.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const args = Object.create(null);
    for (const arg of process.argv.slice(2)) {
      const parsed = /^--(receipt|run|jobs|artifacts|head|tree)=(.+)$/.exec(arg);
      if (!parsed || Object.hasOwn(args, parsed[1])) throw Error('invalid or duplicate verifier option');
      args[parsed[1]] = parsed[2];
    }
    if (Object.keys(args).length !== 6) throw Error('required: --receipt --run --jobs --artifacts --head --tree');
    const [receipt, run, jobs, artifacts] = await Promise.all(
      ['receipt','run','jobs','artifacts'].map(k => readBoundedJson(args[k])));
    console.log(JSON.stringify(assessBooleanWasmEvidence({receipt,run,jobs,artifacts,
      expectedHead:args.head,expectedTree:args.tree}), null, 2));
  } catch (error) {
    console.error('NOT_CERTIFIED: '+(error?.message || error));
    process.exitCode = 1;
  }
}
