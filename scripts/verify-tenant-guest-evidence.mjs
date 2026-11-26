// Independent read-only corroboration gate. It does NOT attest tenant isolation.
// Policy MUST be reviewed and supplied outside the untrusted PR/workflow.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { REQUIRED_GUEST_CASES, validate_tenant_guest_receipt } from './verify-tenant-guest-receipt.mjs';

const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const REPO = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const MAX_ZIP = 128 * 1024 * 1024;
const MAX_UNPACKED = 192 * 1024 * 1024;
const requiredSteps = ['Verify source blob parity', 'Compile AttoLang guest', 'Execute two-tenant guest'];
const digest = b => createHash('sha256').update(b).digest('hex');
const require_true = (ok, why) => { if (!ok) throw new Error(why); };
const enc = s => s.split('/').map(encodeURIComponent).join('/');

// Minimal bounded ZIP central-directory reader; never executes an artifact.
export function unzip_evidence(bytes) {
  const zip = Buffer.from(bytes);
  require_true(zip.length <= MAX_ZIP && zip.length >= 22, 'artifact ZIP size is outside safe bounds');
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50 && i + 22 + zip.readUInt16LE(i + 20) === zip.length) { end = i; break; }
  }
  require_true(end >= 0, 'artifact ZIP has no valid end directory');
  const count = zip.readUInt16LE(end + 10), centralSize = zip.readUInt32LE(end + 12);
  let pos = zip.readUInt32LE(end + 16), total = 0;
  require_true(zip.readUInt16LE(end + 4) === 0 && zip.readUInt16LE(end + 6) === 0 &&
    zip.readUInt16LE(end + 8) === count && count > 0 && count <= 32 &&
    pos + centralSize <= end, 'ZIP directory is split, excessive, or invalid');
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    require_true(pos + 46 <= end && zip.readUInt32LE(pos) === 0x02014b50, 'invalid ZIP central entry');
    const flags = zip.readUInt16LE(pos + 8), method = zip.readUInt16LE(pos + 10);
    const compressed = zip.readUInt32LE(pos + 20), expanded = zip.readUInt32LE(pos + 24);
    const nameLen = zip.readUInt16LE(pos + 28), extraLen = zip.readUInt16LE(pos + 30);
    const commentLen = zip.readUInt16LE(pos + 32), local = zip.readUInt32LE(pos + 42);
    require_true(pos + 46 + nameLen + extraLen + commentLen <= end, 'ZIP entry exceeds directory');
    const name = zip.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    require_true(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(name) && !entries.has(name), 'unsafe or duplicate ZIP entry');
    require_true(!(flags & 1) && (method === 0 || method === 8), 'encrypted or unsupported ZIP entry');
    total += expanded;
    require_true(compressed <= MAX_ZIP && expanded <= MAX_UNPACKED && total <= MAX_UNPACKED, 'ZIP expands beyond resource budget');
    require_true(local + 30 <= pos && zip.readUInt32LE(local) === 0x04034b50, 'invalid ZIP local header');
    const dataOffset = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    require_true(dataOffset + compressed <= pos, 'ZIP entry data outside file area');
    const raw = zip.subarray(dataOffset, dataOffset + compressed);
    const out = method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: expanded + 1 });
    require_true(out.length === expanded, 'ZIP expanded size mismatch');
    entries.set(name, out);
    pos += 46 + nameLen + extraLen + commentLen;
  }
  require_true(pos === zip.readUInt32LE(end + 16) + centralSize, 'ZIP central size mismatch');
  return entries;
}

function files_equal(source, carrier, allowedPath) {
  const entries = tree => {
    require_true(tree && tree.truncated === false && Array.isArray(tree.tree), 'incomplete Git tree response');
    const out = new Map();
    for (const e of tree.tree) {
      if (e.type === 'blob' && e.path !== allowedPath) out.set(e.path, e.mode + ':' + e.sha);
    }
    return out;
  };
  const a = entries(source), b = entries(carrier);
  require_true(a.size === b.size && [...a].every(([k, v]) => b.get(k) === v), 'source/carrier blob parity mismatch');
  return a.size;
}

export async function verify_tenant_guest_evidence(receipt, policy, io) {
  const result = { evidence_status: 'NOT_VERIFIED', enforcement_status: 'NOT_VERIFIED', checks: [], errors: [] };
  try {
    const shape = validate_tenant_guest_receipt(receipt);
    require_true(shape.length === 0, 'receipt shape: ' + shape.join('; '));
    require_true(policy && typeof policy === 'object', 'trusted policy is missing');
    require_true(SHA.test(policy.source_head_sha ?? '') && policy.source_head_sha === receipt.source_head_sha, 'source SHA does not match trusted policy');
    require_true(policy.source_repo === receipt.source_repo && REPO.test(policy.source_repo), 'source repo does not match trusted policy');
    require_true(HASH.test(policy.approved_workflow_sha256 ?? ''), 'approved workflow digest missing from trusted policy');
    require_true(typeof policy.workflow_path === 'string' && /^\.github\/workflows\/[a-zA-Z0-9_.-]+\.ya?ml$/.test(policy.workflow_path), 'invalid protected workflow path');
    require_true(Number.isSafeInteger(policy.workflow_id) && policy.workflow_id > 0, 'approved workflow ID missing');
    const carrier = policy.carrier_repo || policy.source_repo;
    require_true(REPO.test(carrier) && carrier === (receipt.workflow.carrier_repo || receipt.source_repo), 'carrier is not explicitly approved');
    require_true(typeof io?.json === 'function' && typeof io?.bytes === 'function', 'independent API transport is required');
    const api = (repo, suffix) => io.json('/repos/' + enc(repo) + '/' + suffix);
    const sourceCommit = await api(policy.source_repo, 'commits/' + policy.source_head_sha);
    require_true(sourceCommit.sha === policy.source_head_sha && SHA.test(sourceCommit.commit?.tree?.sha ?? ''), 'source commit cannot be independently resolved');
    result.checks.push('exact source commit resolved');

    const run = await api(carrier, 'actions/runs/' + receipt.workflow.run_id);
    require_true(run.id === receipt.workflow.run_id && run.repository?.full_name === carrier &&
      run.conclusion === 'success' && run.status === 'completed' && run.workflow_id === policy.workflow_id,
      'Actions run does not match approved workflow and successful completion');
    require_true(run.path?.split('@')[0] === policy.workflow_path, 'run workflow path does not match protected policy');
    const carrierSHA = carrier === policy.source_repo ? policy.source_head_sha : policy.carrier_head_sha;
    require_true(SHA.test(carrierSHA ?? '') && run.head_sha === carrierSHA, 'Actions run head is not approved exact carrier commit');
    require_true(receipt.workflow.source_head_sha === policy.source_head_sha, 'receipt source head drift');
    result.checks.push('GitHub exact-head Actions run independently resolved');

    const carrierCommit = carrier === policy.source_repo ? sourceCommit : await api(carrier, 'commits/' + carrierSHA);
    require_true(carrierCommit.sha === carrierSHA && SHA.test(carrierCommit.commit?.tree?.sha ?? ''), 'carrier commit cannot be independently resolved');
    const [sourceTree, carrierTree] = await Promise.all([
      api(policy.source_repo, 'git/trees/' + sourceCommit.commit.tree.sha + '?recursive=1'),
      api(carrier, 'git/trees/' + carrierCommit.commit.tree.sha + '?recursive=1')
    ]);
    const checked = files_equal(sourceTree, carrierTree, carrier === policy.source_repo ? null : policy.workflow_path);
    require_true(checked > 0, 'empty mirrored source tree is prohibited');
    result.checks.push('source/carrier blob parity (' + checked + ' entries)');

    const wfFile = await api(carrier, 'contents/' + enc(policy.workflow_path) + '?ref=' + carrierSHA);
    require_true(wfFile.encoding === 'base64' && typeof wfFile.content === 'string', 'approved workflow body not retrievable');
    require_true(digest(Buffer.from(wfFile.content.replace(/\s/g, ''), 'base64')) === policy.approved_workflow_sha256,
      'workflow byte identity is not approved');
    result.checks.push('approved workflow byte hash');

    const jobs = await api(carrier, 'actions/runs/' + run.id + '/jobs?per_page=100&page=1');
    require_true(Array.isArray(jobs.jobs) && jobs.total_count === jobs.jobs.length && jobs.jobs.length > 0 && jobs.jobs.length < 100,
      'jobs missing or paginated beyond audit bound');
    const executed = jobs.jobs.find(j => j.conclusion === 'success' && j.status === 'completed' &&
      requiredSteps.every(name => j.steps?.some(s => s.name === name && s.conclusion === 'success' &&
        s.status === 'completed' && s.started_at && s.completed_at)));
    require_true(executed, 'real compile/guest/parity job steps are absent or unexecuted');
    result.checks.push('GitHub executed guest job ' + executed.id);

    const artifactPage = await api(carrier, 'actions/runs/' + run.id + '/artifacts?per_page=100&page=1');
    require_true(artifactPage.total_count === artifactPage.artifacts?.length && artifactPage.total_count < 100,
      'artifact list is incomplete or paginated');
    const matches = artifactPage.artifacts.filter(a => a.name === 'tenant-guest-evidence' && !a.expired);
    require_true(matches.length === 1 && matches[0].workflow_run?.id === run.id, 'unique unexpired guest evidence artifact missing');
    const artifact = matches[0];
    require_true(/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '') &&
      Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes <= MAX_ZIP,
      'artifact lacks authoritative digest or exceeds size budget');
    const archive = Buffer.from(await io.bytes('/repos/' + enc(carrier) + '/actions/artifacts/' + artifact.id + '/zip'));
    require_true(digest(archive) === artifact.digest.substring(7), 'downloaded artifact byte digest does not match GitHub digest');
    const files = unzip_evidence(archive);
    for (const f of ['source.atto', 'compiler.bin', 'guest.bin', 'execution.json']) {
      require_true(files.has(f), 'missing compiler/guest evidence file ' + f);
    }
    require_true(digest(files.get('source.atto')) === receipt.compiled_guest.source_sha256 &&
      digest(files.get('compiler.bin')) === receipt.compiled_guest.compiler_sha256 &&
      digest(files.get('guest.bin')) === receipt.compiled_guest.binary_sha256,
      'compiler/source/guest artifact digest mismatch');
    const execution = JSON.parse(files.get('execution.json').toString('utf8'));
    require_true(execution.origin === 'atto-source-compiler' &&
      execution.source_head_sha === policy.source_head_sha && execution.run_id === run.id &&
      execution.compiler_sha256 === receipt.compiled_guest.compiler_sha256 &&
      execution.guest_sha256 === receipt.compiled_guest.binary_sha256 &&
      execution.tenant_a === receipt.compiled_guest.tenant_a &&
      execution.tenant_b === receipt.compiled_guest.tenant_b, 'artifact execution manifest provenance mismatch');
    require_true(Array.isArray(execution.cases) && execution.cases.length === REQUIRED_GUEST_CASES.length &&
      REQUIRED_GUEST_CASES.every(id => execution.cases.some(c => c.id === id && c.result === 'pass' &&
        c.execution === 'compiler-produced-guest')), 'actual artifact is missing mandatory guest case evidence');
    result.checks.push('artifact archive, compiled source/compiler/guest hashes and case manifests');
    result.evidence_status = 'PROVENANCE_CORROBORATED';
    // Independent semantic isolation review, host authentication and default-deny remain mandatory.
  } catch (e) { result.errors.push(String(e.message || e)); }
  return result;
}

function github_io(token) {
  const request = async (path, binary) => {
    const res = await fetch('https://api.github.com' + path, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      redirect: 'follow'
    });
    if (!res.ok) throw new Error('GitHub API ' + res.status + ' for ' + path.split('?')[0]);
    return binary ? Buffer.from(await res.arrayBuffer()) : await res.json();
  };
  return { json: path => request(path, false), bytes: path => request(path, true) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) {
    console.error('usage: node scripts/verify-tenant-guest-evidence.mjs RECEIPT.json TRUSTED_POLICY.json');
    process.exitCode = 2;
  } else {
    try {
      const receipt = JSON.parse(readFileSync(process.argv[2], 'utf8'));
      const policy = JSON.parse(readFileSync(process.argv[3], 'utf8'));
      const outcome = await verify_tenant_guest_evidence(receipt, policy, github_io(process.env.GH_TOKEN || process.env.GITHUB_TOKEN));
      console.log(JSON.stringify(outcome, null, 2));
      if (outcome.evidence_status !== 'PROVENANCE_CORROBORATED') process.exitCode = 1;
    } catch (e) { console.error('NOT_VERIFIED:', e.message); process.exitCode = 1; }
  }
}
