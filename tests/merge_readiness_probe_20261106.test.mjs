import {test} from 'node:test';
import assert from 'node:assert/strict';
import {REPOS, assess} from '../scripts/merge_readiness_probe_20261106.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
function fixture(backend = 'java') {
  const [slug, id] = REPOS[backend];
  return {
    repo: {id, full_name: slug, private: true, archived: false, disabled: false},
    main: {name: 'main', protected: true, commit: {sha: BASE}},
    pr: {number: 17, state: 'open', draft: false, mergeable: true,
      base: {ref: 'main', repo: {id}, sha: BASE}, head: {sha: HEAD, repo: {id}},
      user: {login: 'the1mills'}},
    reviews: [{user: {login: 'ORESoftware'}, state: 'APPROVED', commit_id: HEAD,
      id: 501, submitted_at: '2026-11-07T20:00:00Z'}],
    runs: [{run: {id: 71, head_sha: HEAD, event: 'pull_request', status: 'completed',
      conclusion: 'success', run_attempt: 1, repository: {id}, head_repository: {id}},
      jobs: [{id: 81, run_id: 71, head_sha: HEAD, run_attempt: 1,
        status: 'completed', conclusion: 'success', runner_id: 95,
        runner_name: 'GitHub Actions 1', name: 'test',
        steps: [{name: 'Set up job', status: 'completed', conclusion: 'success'},
          {name: 'Execute native tests', status: 'completed', conclusion: 'success'}]}]}],
  };
}
function status(b, mutate) {
  const f = fixture(b); mutate(f);
  return assess(f, b, 17, HEAD);
}
for (const backend of Object.keys(REPOS)) {
  test(backend + ': positive execution evidence is advisory, never release authorization', () => {
    const x = status(backend, () => {});
    assert.equal(x.decision, 'REQUIRES_INDEPENDENT_RELEASE_REVIEW');
    assert.equal(x.merge_authorized, false);
    assert.equal(x.private_source_export_authorized, false);
    assert.equal(x.guest_parity_certified, false);
  });
  const negatives = [
    ['unprotected branch', f => {f.main.protected = false;}],
    ['substituted repository ID', f => {f.repo.id++;}],
    ['public repository', f => {f.repo.private = false;}],
    ['moved head', f => {f.pr.head.sha = 'b'.repeat(40);}],
    ['draft PR', f => {f.pr.draft = true;}],
    ['absent reviewer', f => {f.reviews = [];}],
    ['self-review', f => {f.pr.user.login = 'ORESoftware';}],
    ['stale review', f => {f.reviews[0].commit_id = 'b'.repeat(40);}],
    ['review changes requested', f => {f.reviews.push({user:{login:'second'},state:'CHANGES_REQUESTED',commit_id:HEAD});}],
    ['failed run', f => {f.runs[0].run.conclusion = 'failure';}],
    ['wrong event', f => {f.runs[0].run.event = 'workflow_dispatch';}],
    ['wrong run head', f => {f.runs[0].run.head_sha = 'b'.repeat(40);}],
    ['zero runner ID', f => {f.runs[0].jobs[0].runner_id = 0;}],
    ['no step ledger', f => {f.runs[0].jobs[0].steps = null;}],
    ['housekeeping only', f => {f.runs[0].jobs[0].steps.pop();}],
    ['padded housekeeping impersonation', f => {f.runs[0].jobs[0].steps[1].name = 'Set  up job';}],
    ['failing executed step', f => {f.runs[0].jobs[0].steps[1].conclusion = 'failure';}],
    ['job belongs to wrong run', f => {f.runs[0].jobs[0].run_id = 78;}],
    ['no successful checks', f => {f.runs = [];}],
    ['unverifiable run count', f => {f.runs = Array.from({length: 100}, () => f.runs[0]);}],
  ];
  for (const [name, mutate] of negatives) {
    test(backend + ': deny ' + name, () => {
      const r = status(backend, mutate);
      assert.equal(r.decision, 'BLOCKED');
      assert.ok(r.failures.length > 0);
      assert.equal(r.merge_authorized, false);
    });
  }
}
