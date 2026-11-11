import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const url = new URL('../contracts/borrow-mir-v1/semantic-cases.json', import.meta.url);
const manifest = JSON.parse(await readFile(url, 'utf8'));
const BACKENDS = ['java', 'llvm', 'net', 'wasm', 'forge', 'cranelift', 'js', 'rs', 'hdl'];
const accepted = new Set(['NOT_EXECUTED', 'SOURCE_AUTHORED', 'HOST_ONLY',
  'COMPILER_NEGATIVE_EXECUTED', 'COMPILED_GUEST_EXECUTED', 'CERTIFIED']);
// Independently pinned in code: the manifest must not redefine or weaken
// the evidence it claims is required for certification.
const REQUIRED_RECEIPT_FIELDS = Object.freeze([
  'exactGitCommit', 'exactGitTree', 'sourceBlobInventory',
  'compilerGeneratedMirInventory', 'emittedInstructionInventory',
  'runnerJobId', 'executedSteps', 'compiledGuestReceipt',
  'semanticNegativeReceipt', 'independentReview'
]);
function fail(code) { throw new Error(code); }
function ensure(ok, code) { if (!ok) fail(code); }

// Closed-world, resource-bounded model admission. A source-free oracle must
// never interpret a malformed type witness or an unknown mutable loan kind as
// evidence that a compiler's real typed MIR would be safe.
const LIMITS = Object.freeze({blocks: 4096, edges: 16384,
  operations: 100000, perBlock: 1024, owners: 64, loans: 1024});
const OP_FIELDS = Object.freeze({
  Init: ['op', 'owner', 'copy', 'send'],
  Read: ['op', 'owner'],
  Write: ['op', 'owner'],
  Move: ['op', 'from', 'into'],
  Copy: ['op', 'from', 'into'],
  Drop: ['op', 'owner'],
  Borrow: ['op', 'owner', 'loan', 'kind'],
  EndBorrow: ['op', 'loan'],
  WriteThrough: ['op', 'owner', 'loan'],
  TaskCaptureCopy: ['op', 'owner'],
  TaskCaptureMove: ['op', 'owner'],
  Suspend: ['op'],
  ActorHopBorrow: ['op', 'owner'],
  Return: ['op']
});
function recordOf(value, keys, code = 'E_MIR_SCHEMA') {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value),
    code);
  const actual = Object.keys(value).sort();
  ensure(JSON.stringify(actual) === JSON.stringify([...keys].sort()), code);
}
function id(value, code = 'E_MIR_ID') {
  ensure(Number.isSafeInteger(value) && value > 0, code);
}
function validateOperation(op) {
  ensure(op !== null && typeof op === 'object' && !Array.isArray(op),
    'E_MIR_SCHEMA');
  if (op.op === 'UnknownEffect') fail('E_MIR_UNSUPPORTED_EFFECT');
  // A plain object inherits "constructor", "toString" and "__proto__".
  // Never interpret inherited prototype members as admitted operation tags.
  ensure(typeof op.op === 'string' && Object.hasOwn(OP_FIELDS, op.op),
    'E_MIR_UNSUPPORTED_EFFECT');
  const fields = OP_FIELDS[op.op];
  recordOf(op, fields);
  for (const field of ['owner', 'from', 'into', 'loan']) {
    if (fields.includes(field)) id(op[field], field === 'loan'
      ? 'E_LOAN_ID_ZERO' : 'E_OWNER_ID_ZERO');
  }
  if (op.op === 'Init') {
    ensure(typeof op.copy === 'boolean' && typeof op.send === 'boolean',
      'E_TRAIT_PROOF_TYPE');
  }
  if (op.op === 'Borrow') {
    ensure(op.kind === 'Shared' || op.kind === 'Mutable',
      'E_BORROW_KIND');
  }
}
function freezeState(state) {
  return JSON.stringify({
    live: [...state.live.entries()].sort(([a], [b]) => a - b),
    loans: [...state.loans.entries()].sort(([a], [b]) => a - b),
    nextAcq: state.nextAcq
  });
}
function cloneState(s) {
  return {live: new Map(s.live), loans: new Map(s.loans),
    nextAcq: s.nextAcq};
}
function semantics(graph) {
  const blocks = new Map();
  recordOf(graph, ['entry', 'blocks']);
  ensure(Array.isArray(graph.blocks) && graph.blocks.length > 0
    && graph.blocks.length <= LIMITS.blocks, 'E_CFG_BUDGET');
  ensure(Number.isSafeInteger(graph.entry) && graph.entry >= 0,
    'E_CFG_ENTRY');
  let operations = 0, edges = 0;
  for (const block of graph.blocks) {
    recordOf(block, ['id', 'ops', 'successors']);
    ensure(Number.isSafeInteger(block.id) && block.id >= 0 &&
      !blocks.has(block.id), 'E_CFG_DUPLICATE_BLOCK');
    ensure(Array.isArray(block.ops) &&
      block.ops.length <= LIMITS.perBlock &&
      Array.isArray(block.successors), 'E_CFG_BUDGET');
    operations += block.ops.length;
    edges += block.successors.length;
    ensure(operations <= LIMITS.operations && edges <= LIMITS.edges,
      'E_CFG_BUDGET');
    for (const op of block.ops) validateOperation(op);
    for (const successor of block.successors) ensure(
      Number.isSafeInteger(successor) && successor >= 0, 'E_CFG_EDGE');
    blocks.set(block.id, block);
  }
  ensure(blocks.has(graph.entry), 'E_CFG_ENTRY');
  // Global definitions must be minted once across *all* branch paths.
  const ownerDefs = new Set(), loanDefs = new Set();
  for (const block of blocks.values()) for (const op of block.ops) {
    if (op.op === 'Init' || op.op === 'Move' || op.op === 'Copy') {
      const id = op.op === 'Init' ? op.owner : op.into;
      ensure(Number.isSafeInteger(id) && id > 0, 'E_OWNER_ID_ZERO');
      ensure(!ownerDefs.has(id), 'E_OWNER_DEF_REUSED');
      ownerDefs.add(id);
      ensure(ownerDefs.size <= LIMITS.owners, 'E_OWNER_ID_BUDGET');
    }
    if (op.op === 'Borrow') {
      ensure(Number.isSafeInteger(op.loan) && op.loan > 0, 'E_LOAN_ID_ZERO');
      ensure(!loanDefs.has(op.loan), 'E_LOAN_DEF_REUSED');
      loanDefs.add(op.loan);
      ensure(loanDefs.size <= LIMITS.loans, 'E_LOAN_BUDGET');
    }
  }
  const indegree = new Map([...blocks.keys()].map(x => [x, 0]));
  for (const block of blocks.values()) {
    const unique = new Set(block.successors);
    ensure(unique.size === block.successors.length, 'E_CFG_EDGE');
    for (const next of block.successors) {
      ensure(blocks.has(next), 'E_CFG_EDGE');
      indegree.set(next, indegree.get(next) + 1);
    }
    const returnIndex = block.ops.findIndex(op => op.op === 'Return');
    if (block.successors.length === 0) {
      ensure(returnIndex === block.ops.length - 1 && returnIndex >= 0,
        'E_IMPLICIT_EXIT');
    } else {
      ensure(returnIndex === -1, 'E_RETURN_WITH_SUCCESSOR');
    }
  }
  const ready = [...indegree.entries()].filter(([, degree]) => degree === 0)
    .map(([id]) => id).sort((a, b) => a - b);
  const order = [];
  while (ready.length) {
    const id = ready.shift();
    order.push(id);
    for (const successor of blocks.get(id).successors) {
      indegree.set(successor, indegree.get(successor) - 1);
      if (indegree.get(successor) === 0) {
        ready.push(successor);
        ready.sort((a, b) => a - b);
      }
    }
  }
  ensure(order.length === blocks.size, 'E_CFG_CYCLE_UNPROVEN');
  const incoming = new Map([[graph.entry, [{live: new Map(), loans: new Map(), nextAcq: 0}]]]);
  for (const id of order) {
    const paths = incoming.get(id);
    ensure(paths?.length, 'E_CFG_UNREACHABLE');
    ensure(paths.every(s => freezeState(s) === freezeState(paths[0])), 'E_CFG_JOIN_UNPROVEN');
    const state = cloneState(paths[0]);
    const live = state.live, loans = state.loans;
    const requireLive = owner => {
      ensure(live.has(owner), 'E_USE_AFTER_MOVE_OR_DROP');
      return live.get(owner);
    };
    const anyLoan = owner => [...loans.values()].some(l => l.owner === owner);
    const mutLoan = owner => [...loans.values()].some(l => l.owner === owner && l.kind === 'Mutable');
    for (const op of blocks.get(id).ops) {
      switch (op.op) {
        case 'Init':
          ensure(!live.has(op.owner), 'E_OWNER_ID_REUSED_OR_BUDGET');
          live.set(op.owner, {copy: op.copy, send: op.send, seq: state.nextAcq++});
          break;
        case 'Read':
          requireLive(op.owner);
          ensure(!mutLoan(op.owner), 'E_BORROW_CONFLICT');
          break;
        case 'Write':
          requireLive(op.owner);
          ensure(!anyLoan(op.owner), 'E_BORROW_CONFLICT');
          break;
        case 'Move': {
          const from = requireLive(op.from);
          ensure(!anyLoan(op.from), 'E_BORROW_CONFLICT');
          live.delete(op.from); live.set(op.into, from); break;
        }
        case 'Copy': {
          const from = requireLive(op.from);
          ensure(from.copy, 'E_COPY_PROOF_REQUIRED');
          ensure(!mutLoan(op.from), 'E_BORROW_CONFLICT');
          live.set(op.into, {...from, seq: state.nextAcq++}); break;
        }
        case 'Drop':
          requireLive(op.owner);
          ensure(!anyLoan(op.owner), 'E_BORROW_CONFLICT');
          live.delete(op.owner);
          break;
        case 'Borrow':
          requireLive(op.owner);
          ensure(!mutLoan(op.owner) && (op.kind !== 'Mutable' || !anyLoan(op.owner)),
            'E_BORROW_CONFLICT');
          loans.set(op.loan, {owner: op.owner, kind: op.kind}); break;
        case 'EndBorrow':
          ensure(loans.has(op.loan), 'E_UNKNOWN_LOAN');
          loans.delete(op.loan); break;
        case 'WriteThrough':
          requireLive(op.owner);
          ensure(loans.get(op.loan)?.owner === op.owner &&
            loans.get(op.loan)?.kind === 'Mutable', 'E_MUT_LOAN_REQUIRED');
          break;
        case 'TaskCaptureCopy': {
          const owner = requireLive(op.owner);
          ensure(owner.copy && owner.send, 'E_TASK_CAPTURE_PROOF');
          ensure(!mutLoan(op.owner), 'E_BORROW_CONFLICT'); break;
        }
        case 'TaskCaptureMove': {
          const owner = requireLive(op.owner);
          ensure(owner.send, 'E_TASK_CAPTURE_PROOF');
          ensure(!anyLoan(op.owner), 'E_BORROW_CONFLICT');
          live.delete(op.owner); break;
        }
        case 'Suspend':
          ensure(loans.size === 0, 'E_SUSPEND_WITH_LIVE_LOAN'); break;
        case 'ActorHopBorrow':
          requireLive(op.owner); fail('E_ACTOR_BORROW_ESCAPE');
          break;
        case 'Return':
          ensure(loans.size === 0, 'E_LOAN_ESCAPE'); break;
        default:
          fail('E_MIR_UNSUPPORTED_EFFECT');
      }
    }
    for (const next of blocks.get(id).successors) {
      if (!incoming.has(next)) incoming.set(next, []);
      incoming.get(next).push(cloneState(state));
    }
  }
  return 'accept';
}

export function assess(manifest, receipts = []) {
  const reasons = [];
  ensure(manifest.schema === 'atto-borrow-conformance-v1' && manifest.version === 1,
    'E_CONTRACT_VERSION');
  ensure(JSON.stringify(manifest.backends) === JSON.stringify(BACKENDS), 'E_BACKEND_SET');
  ensure(manifest.cases.length === 22, 'E_CASE_COUNT');
  ensure(new Set(manifest.cases.map(c => c.id)).size === 22, 'E_CASE_ID_REUSE');
  ensure(JSON.stringify(manifest.evidencePolicy?.allowedStatuses) ===
    JSON.stringify([...accepted]), 'E_STATUS_CONTRACT');
  ensure(JSON.stringify(manifest.evidencePolicy?.certifiedRequires) ===
    JSON.stringify(REQUIRED_RECEIPT_FIELDS), 'E_EVIDENCE_CONTRACT');
  ensure(JSON.stringify(Object.keys(manifest.evidence).sort()) ===
    JSON.stringify([...BACKENDS].sort()), 'E_EVIDENCE_BACKEND_SET');
  for (const backend of BACKENDS) {
    const evidence = manifest.evidence[backend];
    ensure(evidence?.status === 'NOT_EXECUTED', 'E_BASELINE_MUST_NOT_ASSERT_PASS');
    reasons.push(backend + ': no executed compiler-backed evidence');
  }
  const receiptIdentities = new Set();
  for (const receipt of receipts) {
    ensure(BACKENDS.includes(receipt.backend), 'E_UNKNOWN_BACKEND');
    const identity = receipt.backend + ':' + receipt.caseId;
    ensure(!receiptIdentities.has(identity), 'E_DUPLICATE_RECEIPT');
    receiptIdentities.add(identity);
    ensure(manifest.cases.some(c => c.id === receipt.caseId), 'E_UNKNOWN_CASE');
    ensure(accepted.has(receipt.status), 'E_UNKNOWN_STATUS');
    if (receipt.status === 'CERTIFIED') {
      for (const field of REQUIRED_RECEIPT_FIELDS) {
        ensure(receipt[field] != null && receipt[field] !== '' &&
          !(Array.isArray(receipt[field]) && receipt[field].length === 0),
          'E_MISSING_CERTIFICATION_EVIDENCE');
      }
      // An internally complete receipt cannot authenticate its own evidence.
      reasons.push(receipt.backend + ': purported certification needs independent external verification');
    }
  }
  return {verified: false, semanticParityCertified: false, authenticityAttested: false,
    sourceFreeModel: true, reasons};
}

test('all nine toolchains and all 22 expected cases have closed, deterministic metadata', () => {
  const result = assess(manifest);
  assert.equal(result.verified, false);
  assert.equal(result.semanticParityCertified, false);
  assert.equal(result.authenticityAttested, false);
  assert.equal(result.reasons.length, 9);
});
test('model applies every restricted case expected oracle without promoting model to guest parity', () => {
  for (const fixture of manifest.cases) {
    let outcome;
    try { outcome = semantics(fixture.graph); }
    catch (err) { outcome = err.message; }
    assert.equal(outcome, fixture.expected === 'accept' ? 'accept' : fixture.diagnostic,
      fixture.id + ' ' + fixture.category);
  }
});
test('forged backend success is never accepted as baseline evidence', () => {
  const corrupted = structuredClone(manifest);
  corrupted.evidence.java.status = 'CERTIFIED';
  assert.throws(() => assess(corrupted), /E_BASELINE_MUST_NOT_ASSERT_PASS/);
});
test('incomplete self-reported certified receipt fails closed', () => {
  assert.throws(() => assess(manifest, [{backend: 'llvm', caseId: 'C01',
    status: 'CERTIFIED', exactGitCommit: 'a'.repeat(40)}]),
  /E_MISSING_CERTIFICATION_EVIDENCE/);
});
test('even self-contained claimed receipts are not independently authenticated', () => {
  const receipt = {backend: 'java', caseId: 'C01', status: 'CERTIFIED'};
  for (const field of manifest.evidencePolicy.certifiedRequires) receipt[field] = 'unverified';
  const result = assess(manifest, [receipt]);
  assert.equal(result.verified, false);
  assert.equal(result.authenticityAttested, false);
});
test('the corpus explicitly fences loops, suspension, actor escape, identity reuse and joins', () => {
  const categories = new Set(manifest.cases.map(c => c.category));
  for (const category of ['loops', 'suspension', 'actor', 'identities', 'joins', 'effects'])
    assert.equal(categories.has(category), true, category);
});

test('a tampered manifest cannot remove required receipt fields', () => {
  const changed = structuredClone(manifest);
  changed.evidencePolicy.certifiedRequires.pop();
  assert.throws(() => assess(changed), /E_EVIDENCE_CONTRACT/);
});
test('a tampered manifest cannot authorize a new evidence status', () => {
  const changed = structuredClone(manifest);
  changed.evidencePolicy.allowedStatuses[1] = 'TRUST_ME_PASS';
  assert.throws(() => assess(changed), /E_STATUS_CONTRACT/);
});
test('a tampered manifest cannot append a hidden backend', () => {
  const changed = structuredClone(manifest);
  changed.evidence.external = {status: 'NOT_EXECUTED'};
  assert.throws(() => assess(changed), /E_EVIDENCE_BACKEND_SET/);
});
test('duplicate receipt identities cannot hide inconsistent results', () => {
  const receipt = {backend: 'java', caseId: 'C01', status: 'HOST_ONLY'};
  assert.throws(() => assess(manifest, [receipt, receipt]), /E_DUPLICATE_RECEIPT/);
});
function basic(ops) {
  return {entry: 0, blocks: [{id: 0, ops, successors: []}]};
}
const sampleInit = () => ({op: 'Init', owner: 1, copy: true, send: false});
test('a string Copy witness cannot pass as a real boolean Copy proof', () => {
  assert.throws(() => semantics(basic([
    {...sampleInit(), copy: 'false'},
    {op: 'Copy', from: 1, into: 2}, {op: 'Return'}
  ])), /E_TRAIT_PROOF_TYPE/);
});
test('a string Send witness cannot pass Task capture proof', () => {
  assert.throws(() => semantics(basic([
    {...sampleInit(), send: 'false'},
    {op: 'TaskCaptureCopy', owner: 1}, {op: 'Return'}
  ])), /E_TRAIT_PROOF_TYPE/);
});
test('an unknown borrow kind cannot be silently treated as a shared loan', () => {
  assert.throws(() => semantics(basic([
    sampleInit(), {op: 'Borrow', owner: 1, loan: 2, kind: 'ExclusiveButUnknown'},
    {op: 'Read', owner: 1}, {op: 'EndBorrow', loan: 2}, {op: 'Return'}
  ])), /E_BORROW_KIND/);
});
test('borrow metadata must include kind explicitly', () => {
  assert.throws(() => semantics(basic([
    sampleInit(), {op: 'Borrow', owner: 1, loan: 2},
    {op: 'EndBorrow', loan: 2}, {op: 'Return'}
  ])), /E_MIR_SCHEMA/);
});
test('unexpected effect fields cannot be silently discarded', () => {
  assert.throws(() => semantics(basic([
    {...sampleInit(), hiddenEffect: 'CallNative'}, {op: 'Return'}
  ])), /E_MIR_SCHEMA/);
});
test('unrecognized operation, even inside a dead branch, is rejected', () => {
  assert.throws(() => semantics(basic([
    sampleInit(), {op: 'UnknownNativeCall', owner: 1}, {op: 'Return'}
  ])), /E_MIR_UNSUPPORTED_EFFECT/);
});
test('CFG edges must have integral nonnegative identities and bounded count', () => {
  assert.throws(() => semantics({entry: 0, blocks: [
    {id: 0, ops: [], successors: ['1']},
    {id: 1, ops: [{op: 'Return'}], successors: []}
  ]}), /E_CFG_EDGE/);
  assert.throws(() => semantics({entry: 0, blocks: [
    {id: 0, ops: [], successors: Array(LIMITS.edges + 1).fill(1)},
    {id: 1, ops: [{op: 'Return'}], successors: []}
  ]}), /E_CFG_BUDGET/);
});
test('invalid owner and loan identities are not truthy IDs', () => {
  assert.throws(() => semantics(basic([
    {...sampleInit(), owner: true}, {op: 'Return'}
  ])), /E_OWNER_ID_ZERO/);
  assert.throws(() => semantics(basic([
    sampleInit(), {op: 'Borrow', owner: 1, loan: '7', kind: 'Shared'},
    {op: 'Return'}
  ])), /E_LOAN_ID_ZERO/);
});
test('unknown graph and block properties reject before checking semantics', () => {
  const g = basic([sampleInit(), {op: 'Return'}]);
  assert.throws(() => semantics({...g, ignored: true}), /E_MIR_SCHEMA/);
  assert.throws(() => semantics({entry: 0, blocks: [
    {...g.blocks[0], implicitUnwind: true}
  ]}), /E_MIR_SCHEMA/);
});

test('prototype property names never become recognized ownership operations', () => {
  for (const name of ['__proto__', 'constructor', 'toString']) {
    assert.throws(() => semantics(basic([
      sampleInit(), {op: name}, {op: 'Return'}
    ])), /E_MIR_UNSUPPORTED_EFFECT/, name);
  }
});
