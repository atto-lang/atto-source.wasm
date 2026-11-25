import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REPOS, assess } from '../scripts/merge_readiness_probe_20261106.mjs';

// This is a source-only, read-only *advisory* gate. It never authorizes
// an actual merge, private source export, or guest compiler conformance.
const HEAD = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);
function fixture(backend, author = 'ORESoftware', approver = 'the1mills') {
  const [slug, id] = REPOS[backend];
  return {
    repo: { id, full_name: slug, private: true, archived: false, disabled: false },
    main: { name: 'main', protected: true },
    pr: { number: 73, state: 'open', draft: false, mergeable: true,
      base: { ref: 'main', repo: { id } },
      head: { sha: HEAD, repo: { id } }, user: { login: author } },
    reviews: [{ user: { login: approver }, state: 'APPROVED', commit_id: HEAD }],
    runs: [{ run: { id: 91, head_sha: HEAD, event: 'pull_request',
      status: 'completed', conclusion: 'success', run_attempt: 2,
      repository: { id }, head_repository: { id } },
      jobs: [{ id: 92, run_id: 91, head_sha: HEAD, run_attempt: 2,
        status: 'completed', conclusion: 'success', runner_id: 93,
        runner_name: 'GitHub Actions 93', name: 'guest-smoke',
        steps: [{ name: 'Set up job', status: 'completed', conclusion: 'success' },
          { name: 'Compile and run AttoLang guest', status: 'completed',
            conclusion: 'success' }] }] }],
  };
}
function assessMutation(backend, mutation, author, approver) {
  const x = fixture(backend, author, approver);
  mutation(x);
  return assess(x, backend, 73, HEAD);
}
function isAdvisory(result) {
  assert.equal(result.decision, 'REQUIRES_INDEPENDENT_RELEASE_REVIEW');
  assert.deepEqual(result.failures, []);
  assert.equal(result.merge_authorized, false);
  assert.equal(result.private_source_export_authorized, false);
  assert.equal(result.guest_parity_certified, false);
}
function isBlocked(result) {
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(result.failures.length > 0);
  assert.equal(result.merge_authorized, false);
  assert.equal(result.private_source_export_authorized, false);
  assert.equal(result.guest_parity_certified, false);
}
for (const backend of Object.keys(REPOS)) {
  test(backend + ': ORESoftware author, the1mills exact-head approval is advisory', () => {
    isAdvisory(assessMutation(backend, () => {}, 'ORESoftware', 'the1mills'));
  });
  test(backend + ': the1mills author, ORESoftware exact-head approval is advisory', () => {
    isAdvisory(assessMutation(backend, () => {}, 'the1mills', 'ORESoftware'));
  });
  test(backend + ': mixed-case reviewer account is recognized', () => {
    isAdvisory(assessMutation(backend, x => { x.reviews[0].user.login = 'The1Mills'; }));
  });
  test(backend + ': COMMENTED after an approval does not revoke it', () => {
    isAdvisory(assessMutation(backend, x => {
      x.reviews.push({ user: { login: 'the1mills' }, state: 'COMMENTED', commit_id: HEAD });
    }));
  });
  test(backend + ': fresh alternate designated approval survives a stale one', () => {
    isAdvisory(assessMutation(backend, x => {
      x.pr.user.login = 'maintainer';
      x.reviews.push({ user: { login: 'ORESoftware' }, state: 'APPROVED', commit_id: OTHER });
    }));
  });
  const negativeCases = [
    ['unrecognized approver', x => { x.reviews[0].user.login = 'random-reviewer'; }],
    ['self approval by the1mills', x => { x.pr.user.login = 'the1mills'; }],
    ['stale approval on wrong commit', x => { x.reviews[0].commit_id = OTHER; }],
    ['dismissed approval', x => { x.reviews.push({ user: { login: 'the1mills' }, state: 'DISMISSED', commit_id: HEAD }); }],
    ['later changes requested', x => { x.reviews.push({ user: { login: 'the1mills' }, state: 'CHANGES_REQUESTED', commit_id: HEAD }); }],
    ['third-party changes requested', x => { x.reviews.push({ user: { login: 'third' }, state: 'CHANGES_REQUESTED', commit_id: HEAD }); }],
    ['comment without approval', x => { x.reviews[0].state = 'COMMENTED'; }],
    ['review missing reviewer identity', x => { delete x.reviews[0].user.login; }],
    ['review missing commit', x => { delete x.reviews[0].commit_id; }],
    ['missing review ledger', x => { x.reviews = null; }],
    ['overlarge review ledger', x => { x.reviews = Array.from({ length: 100 }, () => x.reviews[0]); }],
    ['wrong base repository identity', x => { x.pr.base.repo.id += 1; }],
    ['wrong head repository identity', x => { x.pr.head.repo.id += 1; }],
    ['disabled repository', x => { x.repo.disabled = true; }],
    ['archived repository', x => { x.repo.archived = true; }],
    ['unprotected main', x => { x.main.protected = false; }],
    ['PR closed', x => { x.pr.state = 'closed'; }],
    ['PR not mergeable', x => { x.pr.mergeable = null; }],
    ['workflow pending', x => { x.runs[0].run.status = 'in_progress'; }],
    ['workflow wrong repository', x => { x.runs[0].run.repository.id += 1; }],
    ['workflow wrong head repository', x => { x.runs[0].run.head_repository.id += 1; }],
    ['workflow attempt zero', x => { x.runs[0].run.run_attempt = 0; }],
    ['job wrong attempt', x => { x.runs[0].jobs[0].run_attempt = 1; }],
    ['job wrong SHA', x => { x.runs[0].jobs[0].head_sha = OTHER; }],
    ['duplicate job IDs', x => { x.runs[0].jobs.push({ ...x.runs[0].jobs[0] }); }],
    ['no job ledger', x => { x.runs[0].jobs = null; }],
    ['zero runner ID', x => { x.runs[0].jobs[0].runner_id = 0; }],
    ['no runner name', x => { x.runs[0].jobs[0].runner_name = ''; }],
    ['empty steps', x => { x.runs[0].jobs[0].steps = []; }],
    ['null steps', x => { x.runs[0].jobs[0].steps = null; }],
    ['all housekeeping steps', x => { x.runs[0].jobs[0].steps = [x.runs[0].jobs[0].steps[0]]; }],
    ['pre/post hooks only', x => { x.runs[0].jobs[0].steps = [
      { name: 'Pre checkout', status: 'completed', conclusion: 'success' },
      { name: 'Post checkout', status: 'completed', conclusion: 'success' }]; }],
    ['skipped guest step', x => { x.runs[0].jobs[0].steps[1].conclusion = 'skipped'; }],
    ['unfinished guest step', x => { x.runs[0].jobs[0].steps[1].status = 'in_progress'; }],
    ['control characters in step name', x => { x.runs[0].jobs[0].steps[1].name = 'guest\nsmoke'; }],
    ['201 steps', x => { x.runs[0].jobs[0].steps = Array.from({ length: 201 }, () => x.runs[0].jobs[0].steps[1]); }],
    ['duplicated run ID', x => { x.runs.push(x.runs[0]); }],
    ['100 runs', x => { x.runs = Array.from({ length: 100 }, () => x.runs[0]); }],
  ];
  for (const [name, mutate] of negativeCases) {
    test(backend + ': deny ' + name, () => {
      isBlocked(assessMutation(backend, mutate));
    });
  }
}
test('reject truncated SHA before inspecting a snapshot', () => {
  assert.throws(() => assess({}, 'java', 73, 'a'.repeat(39)), TypeError);
});
test('reject unknown backend before inspecting a snapshot', () => {
  assert.throws(() => assess({}, 'bogus', 73, HEAD), TypeError);
});
test('reject invalid PR numbers before inspecting a snapshot', () => {
  assert.throws(() => assess({}, 'java', 0, HEAD), TypeError);
});
