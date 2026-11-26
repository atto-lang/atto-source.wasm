import test from 'node:test';
import assert from 'node:assert/strict';
import { verify_tenant_ci_provenance } from '../scripts/verify-tenant-ci-provenance.mjs';

const repository = 'ores-truffle-oreslang/oreslang-source.wasm';
const head = 'a'.repeat(40), tree = 'b'.repeat(40), run_id = 120, job_id = 500;
const valid = () => ({
  receipt: { source_repo: repository, source_head_sha: head, workflow: {
    run_id, url: 'https://github.com/' + repository + '/actions/runs/' + run_id,
    conclusion: 'success'
  } },
  trusted: { repository, source_head_sha: head, source_tree_sha: tree, job_id },
  responses: {
    commit: { sha: head, commit: { tree: { sha: tree } } },
    run: { id: run_id, html_url: 'https://github.com/' + repository + '/actions/runs/' + run_id,
      repository: { full_name: repository }, head_sha: head, status: 'completed',
      conclusion: 'success', run_attempt: 1 },
    jobs: { jobs: [{ id: job_id, run_id, run_attempt: 1, head_sha: head,
      status: 'completed', conclusion: 'success', steps: [{ name: 'execute compiled guest',
        status: 'completed', conclusion: 'success', started_at: '2026-11-09T16:00:00Z',
        completed_at: '2026-11-09T16:00:01Z' }] }] }
  }
});
async function check(change = () => {}) {
  const x = valid(); change(x);
  const get_json = async path => {
    if (path.includes('/commits/')) return x.responses.commit;
    if (path.endsWith('/actions/runs/' + run_id)) return x.responses.run;
    if (path.includes('/jobs?')) return x.responses.jobs;
    throw new Error('unexpected request');
  };
  return verify_tenant_ci_provenance(x.receipt, x.trusted, get_json);
}
const reject = async (change, re) => assert.match((await check(change)).join('\n'), re);

test('only authentic-looking independent run metadata passes metadata-only gate', async () => {
  assert.deepEqual(await check(), []);
});
test('rejects user-controlled source head or repository', async () => {
  await reject(x => { x.receipt.source_head_sha = 'f'.repeat(40); }, /independently pinned/);
  await reject(x => { x.receipt.source_repo = 'attack/repo'; }, /independently pinned/);
});
test('rejects missing or tainted trusted pins', async () => {
  await reject(x => { x.trusted.source_tree_sha = ''; }, /trusted repository/);
  await reject(x => { x.trusted.job_id = 0; }, /trusted repository/);
});
test('rejects forged commit identity or changed source tree', async () => {
  await reject(x => { x.responses.commit.sha = 'c'.repeat(40); }, /source commit or tree/);
  await reject(x => { x.responses.commit.commit.tree.sha = 'c'.repeat(40); }, /source commit or tree/);
});
test('rejects forged workflow ID, repo, and wrong head', async () => {
  await reject(x => { x.responses.run.id = 121; }, /run ID, repository/);
  await reject(x => { x.responses.run.repository.full_name = 'other/repo'; }, /run ID, repository/);
  await reject(x => { x.responses.run.head_sha = 'f'.repeat(40); }, /run ID, repository/);
});
test('rejects fake workflow success', async () => {
  await reject(x => { x.responses.run.conclusion = 'failure'; }, /workflow is not/);
  await reject(x => { x.responses.run.status = 'queued'; }, /workflow is not/);
});
test('rejects job wrong identity and failed execution', async () => {
  await reject(x => { x.responses.jobs.jobs[0].run_id = 121; }, /job conclusion/);
  await reject(x => { x.responses.jobs.jobs[0].head_sha = 'f'.repeat(40); }, /job conclusion/);
  await reject(x => { x.responses.jobs.jobs[0].run_attempt = 2; }, /job conclusion/);
  await reject(x => { x.responses.jobs.jobs[0].conclusion = 'failure'; }, /job conclusion/);
});
test('rejects wrong job and repeated job IDs', async () => {
  await reject(x => { x.trusted.job_id = 123; }, /independently pinned job/);
  await reject(x => { x.responses.jobs.jobs.push(x.responses.jobs.jobs[0]); }, /duplicated GitHub job IDs/);
});
test('rejects zero-step metadata and counterfeit guest steps', async () => {
  await reject(x => { x.responses.jobs.jobs[0].steps = []; }, /zero-step/);
  await reject(x => { x.responses.jobs.jobs[0].steps[0].name = 'upload host-only report'; }, /compiled guest step/);
  await reject(x => { x.responses.jobs.jobs[0].steps[0].conclusion = 'skipped'; }, /compiled guest step/);
});
test('rejects absent or invalid guest step timing', async () => {
  await reject(x => { x.responses.jobs.jobs[0].steps[0].started_at = null; }, /execution timestamps/);
  await reject(x => { x.responses.jobs.jobs[0].steps[0].completed_at = '2026-11-09T15:59:00Z'; }, /execution timestamps/);
  await reject(x => { x.responses.jobs.jobs[0].steps.push(x.responses.jobs.jobs[0].steps[0]); }, /ambiguous/);
});
test('rejects unverified cross-org private source mirrors even if claims pass', async () => {
  await reject(x => { x.receipt.workflow.carrier_repo = 'some-other-org/private'; }, /cross-organization carrier blocked/);
});
test('fails closed on GitHub API read failure', async () => {
  const x = valid(); const errors = await verify_tenant_ci_provenance(x.receipt,x.trusted,
    async () => {throw new Error('permission denied');});
  assert.match(errors.join('\n'), /GitHub API lookup failed/);
});
