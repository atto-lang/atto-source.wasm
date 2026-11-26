// Read-only GitHub observation gate. A PASS here verifies CI metadata, NEVER guest enforcement.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha40 = /^[0-9a-f]{40}$/;
const repoPattern = /^ores-truffle-oreslang\/oreslang-source\.(java|llvm|wasm|forge|net)$/;
const completed = x => x?.status === 'completed' && x?.conclusion === 'success';
const validTime = x => typeof x === 'string' && !Number.isNaN(Date.parse(x));
const positive = x => Number.isSafeInteger(x) && x > 0;

export async function verify_tenant_ci_provenance(receipt, trusted, get_json) {
  const errors = [];
  const deny = reason => errors.push(reason);
  // These expectations must originate with an independent caller, NEVER from the receipt.
  const { repository, source_head_sha, source_tree_sha, job_id } = trusted ?? {};
  if (!repoPattern.test(repository ?? '') || !sha40.test(source_head_sha ?? '') ||
      !sha40.test(source_tree_sha ?? '') || !positive(job_id)) {
    return ['trusted repository, head SHA, tree SHA and job ID are required'];
  }
  if (typeof get_json !== 'function') return ['independent GitHub API reader required'];
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return ['invalid receipt'];
  const workflow = receipt.workflow;
  if (receipt.source_repo !== repository || receipt.source_head_sha !== source_head_sha) {
    return ['receipt does not match independently pinned source repository and head'];
  }
  if (!workflow || !positive(workflow.run_id)) return ['valid workflow run ID required'];
  if (workflow.carrier_repo && workflow.carrier_repo !== repository) {
    return ['cross-organization carrier blocked: independent full-tree mirror authorization and comparison not yet implemented'];
  }
  const run_id = workflow.run_id;
  const prefix = '/repos/' + repository;
  let commit, run, page = 1, jobs = [];
  try {
    commit = await get_json(prefix + '/commits/' + source_head_sha);
    run = await get_json(prefix + '/actions/runs/' + run_id);
    for (; page <= 10; ++page) {
      const result = await get_json(prefix + '/actions/runs/' + run_id + '/jobs?per_page=100&page=' + page);
      if (!result || !Array.isArray(result.jobs)) throw new Error('malformed GitHub jobs payload');
      jobs.push(...result.jobs);
      if (result.jobs.length < 100) break;
    }
  } catch (error) {
    return ['independent GitHub API lookup failed: ' + (error instanceof Error ? error.message : String(error))];
  }
  if (page > 10) deny('jobs pagination incomplete');
  if (commit?.sha !== source_head_sha || commit?.commit?.tree?.sha !== source_tree_sha) {
    deny('source commit or tree does not match independent pin');
  }
  const expected_url = 'https://github.com/' + repository + '/actions/runs/' + run_id;
  if (run?.id !== run_id || run?.html_url !== expected_url || workflow.url !== expected_url ||
      run?.repository?.full_name !== repository || run?.head_sha !== source_head_sha) {
    deny('run ID, repository, URL or head SHA mismatch');
  }
  if (!completed(run) || workflow.conclusion !== 'success') deny('workflow is not independently successful');
  if (!positive(run?.run_attempt)) deny('missing run attempt');
  if (jobs.length === 0 || (run?.jobs_url && !run.jobs_url.endsWith('/actions/runs/' + run_id + '/jobs'))) {
    deny('no trustworthy job listing');
  }
  if (new Set(jobs.map(x => x.id)).size !== jobs.length) deny('duplicated GitHub job IDs');
  const job = jobs.find(x => x.id === job_id);
  if (!job) {
    deny('independently pinned job is missing');
  } else {
    if (!completed(job) || job.run_id !== run_id || job.head_sha !== source_head_sha ||
        (positive(job.run_attempt) && job.run_attempt !== run.run_attempt)) {
      deny('job conclusion, run identity, attempt or head does not match');
    }
    const steps = job.steps;
    if (!Array.isArray(steps) || steps.length === 0) {
      deny('zero-step job: NOT_EXECUTED');
    } else {
      const matching = steps.filter(s => s?.name === 'execute compiled guest');
      if (matching.length !== 1 || !completed(matching[0]) ||
          !validTime(matching[0]?.started_at) || !validTime(matching[0]?.completed_at) ||
          Date.parse(matching[0]?.completed_at) < Date.parse(matching[0]?.started_at)) {
        deny('compiled guest step absent, ambiguous, incomplete or without execution timestamps');
      }
    }
  }
  return errors;
}

export async function github_read_only_get(path, token = process.env.GITHUB_TOKEN) {
  if (!/^\/repos\/ores-truffle-oreslang\/oreslang-source\.(java|llvm|wasm|forge|net)\//.test(path)) {
    throw new Error('repository API path is not allowlisted');
  }
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch('https://api.github.com' + path, {
    method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error('GitHub API status ' + response.status);
  return response.json();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [receipt_path, repository, source_head_sha, source_tree_sha, raw_job_id] = process.argv.slice(2);
  if (process.argv.length !== 7 || !/^[1-9]\d*$/.test(raw_job_id ?? '')) {
    console.error('Usage: node scripts/verify-tenant-ci-provenance.mjs receipt.json repo head_sha tree_sha job_id');
    process.exitCode = 2;
  } else {
    try {
      const receipt = JSON.parse(readFileSync(receipt_path, 'utf8'));
      const failures = await verify_tenant_ci_provenance(receipt,
        { repository, source_head_sha, source_tree_sha, job_id: Number(raw_job_id) }, github_read_only_get);
      if (failures.length) { for (const failure of failures) console.error('DENY: ' + failure); process.exitCode = 1; }
      else console.log('CI_METADATA_VERIFIED_ONLY: real GitHub run and step observed; compiled-guest security NOT verified');
    } catch (error) {
      console.error('DENY: ' + (error instanceof Error ? error.message : String(error)));
      process.exitCode = 1;
    }
  }
}
