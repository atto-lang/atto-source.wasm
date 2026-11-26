import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUIRED_GUEST_CASES,
  validate_tenant_guest_receipt
} from '../scripts/verify-tenant-guest-receipt.mjs';

// Synthetic metadata validates parser behavior only: this is NOT a guest execution receipt.
const make_receipt = () => ({
  backend: 'wasm',
  source_repo: 'ores-truffle-oreslang/oreslang-source.wasm',
  source_head_sha: 'a'.repeat(40),
  workflow: {
    source_head_sha: 'a'.repeat(40),
    run_id: 42,
    url: 'https://github.com/ores-truffle-oreslang/oreslang-source.wasm/actions/runs/42',
    conclusion: 'success',
    jobs: [{
      conclusion: 'success',
      steps: [{ name: 'execute compiled guest', conclusion: 'success' }]
    }]
  },
  compiled_guest: {
    origin: 'atto-source-compiler',
    source_sha256: 'b'.repeat(64),
    compiler_sha256: 'c'.repeat(64),
    binary_sha256: 'd'.repeat(64),
    tenant_a: 'tenant-1#1',
    tenant_b: 'tenant-2#1'
  },
  cases: REQUIRED_GUEST_CASES.map(id => ({
    id, execution: 'compiler-produced-guest', result: 'pass'
  }))
});

const rejects = (change, expected) => {
  const receipt = make_receipt();
  change(receipt);
  assert.match(validate_tenant_guest_receipt(receipt).join('\n'), expected);
};

test('synthetic complete receipt satisfies only structural admission', () => {
  assert.deepEqual(validate_tenant_guest_receipt(make_receipt()), []);
});
test('rejects missing entire receipt', () => {
  assert.match(validate_tenant_guest_receipt(null).join('\n'), /must be a JSON object/);
});
test('rejects unsupported or mismatched backend', () => {
  rejects(r => { r.backend = 'hdl'; }, /backend must/);
  rejects(r => { r.source_repo = 'other/other'; }, /source_repo must/);
});
test('rejects absent or mismatched commit provenance', () => {
  rejects(r => { r.source_head_sha = 'abcd'; }, /40 lowercase hex/);
  rejects(r => { r.workflow.source_head_sha = 'f'.repeat(40); }, /source head must equal/);
});
test('rejects zero-step and failed workflows', () => {
  rejects(r => { r.workflow.jobs[0].steps = []; }, /zero-step failures/);
  rejects(r => { r.workflow.conclusion = 'failure'; }, /must conclude success/);
  rejects(r => { r.workflow.jobs[0].steps[0].name = 'static host-only test'; }, /compiled-guest step/);
});
test('rejects nonverifiable workflow URL and run ID', () => {
  rejects(r => { r.workflow.run_id = 0; }, /run_id/);
  rejects(r => { r.workflow.url += '/wrong'; }, /workflow URL/);
});
test('rejects unverified private carrier mirroring', () => {
  rejects(r => { r.workflow.carrier_repo = 'benefactor-cc/private'; }, /source blob matches/);
  rejects(r => { r.workflow.carrier_repo = 'benefactor-cc/private'; r.workflow.verified_blob_count = 19; r.workflow.blob_mismatches = 1; }, /zero mismatches/);
});
test('rejects host-only, simulated, or incomplete guest evidence', () => {
  rejects(r => { r.cases[0].execution = 'host-only'; }, /host-only/);
  rejects(r => { r.cases[0].result = 'pending'; }, /pending/);
  rejects(r => { r.cases.pop(); }, /missing guest case/);
  rejects(r => { r.cases.push(r.cases[0]); }, /duplicate case/);
});
test('rejects non-compiled guests and impossible digest claims', () => {
  rejects(r => { r.compiled_guest.origin = 'hand-authored-wasm'; }, /Atto source compiler/);
  rejects(r => { r.compiled_guest.compiler_sha256 = 'unknown'; }, /must be sha256/);
});
test('rejects single-tenant simulations of cross-tenant security', () => {
  rejects(r => { r.compiled_guest.tenant_b = r.compiled_guest.tenant_a; }, /two distinct/);
});
