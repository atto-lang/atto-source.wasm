// Offline receipt-shape gate, not independent attestation. No network, secrets or writes.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha40 = /^[a-f0-9]{40}$/;
const sha256 = /^[a-f0-9]{64}$/;
const backends = new Set(['java', 'llvm', 'wasm', 'forge', 'net']);
export const REQUIRED_GUEST_CASES = Object.freeze([
  'tenant_aggregate_quota_survives_restart',
  'revoked_capability_denied_at_dispatch',
  'forged_cross_tenant_actorref_denied',
  'authorized_broker_delivery_exactly_once',
  'unrelated_tenant_survives_denial'
]);

export function validate_tenant_guest_receipt(receipt) {
  const errors = [];
  const fail = message => errors.push(message);
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return ['receipt must be a JSON object'];
  }
  const { backend, source_repo, source_head_sha, workflow, compiled_guest, cases } = receipt;
  if (!backends.has(backend)) fail('backend must be an exact source backend name');
  if (source_repo !== 'ores-truffle-oreslang/oreslang-source.' + backend) {
    fail('source_repo must match the backend source repository');
  }
  if (!sha40.test(source_head_sha ?? '')) fail('source_head_sha must be 40 lowercase hex');
  if (!workflow || typeof workflow !== 'object') {
    fail('workflow evidence is required');
  } else {
    if (workflow.source_head_sha !== source_head_sha) fail('workflow source head must equal source_head_sha');
    if (workflow.conclusion !== 'success') fail('workflow must conclude success');
    if (!Number.isSafeInteger(workflow.run_id) || workflow.run_id < 1) fail('workflow run_id must be positive');
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/[0-9]+$/.test(workflow.url ?? '') ||
        !workflow.url.endsWith('/' + workflow.run_id)) fail('workflow URL must identify the run');
    if (!Array.isArray(workflow.jobs) ||
        !workflow.jobs.some(job => job?.conclusion === 'success' &&
          Array.isArray(job.steps) && job.steps.length > 0 &&
          job.steps.some(step => step?.conclusion === 'success' && step.name === 'execute compiled guest'))) {
      fail('a successful job with an executed compiled-guest step is required; zero-step failures are not tests');
    }
    if (workflow.carrier_repo && workflow.carrier_repo !== source_repo &&
        (workflow.verified_blob_count < 1 || workflow.blob_mismatches !== 0)) {
      fail('private carrier requires source blob matches and zero mismatches');
    }
  }
  if (!compiled_guest || typeof compiled_guest !== 'object') {
    fail('compiled guest provenance is required');
  } else {
    if (compiled_guest.origin !== 'atto-source-compiler') fail('guest must originate in Atto source compiler');
    for (const field of ['source_sha256', 'compiler_sha256', 'binary_sha256']) {
      if (!sha256.test(compiled_guest[field] ?? '')) fail('compiled_guest.' + field + ' must be sha256');
    }
    if (typeof compiled_guest.tenant_a !== 'string' || !compiled_guest.tenant_a.trim() ||
        typeof compiled_guest.tenant_b !== 'string' || !compiled_guest.tenant_b.trim() ||
        compiled_guest.tenant_a === compiled_guest.tenant_b) {
      fail('two distinct nonempty tenant identities are required');
    }
  }
  if (!Array.isArray(cases)) {
    fail('guest cases array is required');
  } else {
    const seen = new Set();
    for (const item of cases) {
      if (!item || typeof item.id !== 'string') { fail('case must contain an id'); continue; }
      if (seen.has(item.id)) fail('duplicate case ' + item.id);
      seen.add(item.id);
      if (item.execution !== 'compiler-produced-guest' || item.result !== 'pass') {
        fail(item.id + ': host-only, simulated, pending, or failed evidence is unacceptable');
      }
    }
    for (const id of REQUIRED_GUEST_CASES) if (!seen.has(id)) fail('missing guest case ' + id);
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error('usage: node scripts/verify-tenant-guest-receipt.mjs path/to/receipt.json');
    process.exitCode = 2;
  } else {
    try {
      const receipt = JSON.parse(readFileSync(process.argv[2], 'utf8'));
      const errors = validate_tenant_guest_receipt(receipt);
      if (errors.length) { for (const error of errors) console.error('DENY:', error); process.exitCode = 1; }
      else console.log('Receipt structurally complete (NOT independent attestation of guest enforcement).');
    } catch (error) {
      console.error('DENY: unreadable or invalid JSON receipt:', error.message);
      process.exitCode = 1;
    }
  }
}
