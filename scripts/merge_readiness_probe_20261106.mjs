#!/usr/bin/env node
/**
 * Read-only, fail-closed source-repository merge diagnostic.
 * A passing report is NOT approval to merge or transfer private Git objects:
 * CODEOWNER, required checks, protected policy, and guest parity need separate proof.
 */
import { pathToFileURL } from 'node:url';
import {read_strict_github_response} from './strict_github_evidence_20261106.mjs';

export const REPOS = Object.freeze({
  java: ['ores-truffle-oreslang/oreslang-source.java', 1400792274],
  llvm: ['ores-truffle-oreslang/oreslang-source.llvm', 1410897874],
  wasm: ['ores-truffle-oreslang/oreslang-source.wasm', 1419858954],
  forge: ['ores-truffle-oreslang/oreslang-source.forge', 1419703674],
  net: ['ores-truffle-oreslang/oreslang-source.net', 1419704375],
});

const SHA = /^[a-f0-9]{40}$/;
const name_ok = s => typeof s === 'string' && /^[\x20-\x7e]{1,180}$/.test(s)
  && s.trim() === s && !/\s{2,}/.test(s);
const housekeeping = new Set(['set up job', 'complete job', 'initialize containers',
  'start containers', 'stop containers']);
// Advisory step-name classification, not proof of executed compiler guest work.
const setupOnly = /^(?:(?:run\s+)?actions\/(?:checkout|setup-[a-z0-9_-]+|cache|upload-artifact|download-artifact)(?:@|\/|$)|(?:run\s+)?(?:checkout|check out|setup|set up|cache|restore cache|save cache|upload artifacts?|download artifacts?|install dependencies|npm ci|npm install|pnpm install|yarn install|dotnet restore|cargo fetch)(?:[\s:_-]|$))/i;
const meaningful = s => name_ok(s) && !housekeeping.has(s.toLowerCase())
  && !/^(?:pre|post)(?:[\s:_-]|$)/i.test(s) && !setupOnly.test(s);
const own = (o, k) => o !== null && typeof o === 'object'
  && Object.prototype.hasOwnProperty.call(o, k);

export function assess(snapshot, backend, number, expected_head) {
  if (!own(REPOS, backend) || !Number.isSafeInteger(number) || number < 1
      || typeof expected_head !== 'string' || !SHA.test(expected_head)) {
    throw new TypeError('invalid pinned repository, PR, or 40-digit HEAD SHA');
  }
  const [slug, id] = REPOS[backend];
  const failures = [];
  const deny = code => { if (!failures.includes(code)) failures.push(code); };
  if (!snapshot || typeof snapshot !== 'object') deny('MISSING_SNAPSHOT');
  const repo = snapshot?.repo;
  if (!repo || repo.id !== id || repo.full_name !== slug
      || repo.private !== true || repo.archived !== false || repo.disabled !== false) {
    deny('SOURCE_IDENTITY_OR_PRIVACY');
  }
  if (snapshot?.main?.name !== 'main' || snapshot?.main?.protected !== true) {
    deny('SOURCE_MAIN_NOT_VERIFIABLY_PROTECTED');
  }
  const pr = snapshot?.pr;
  if (!pr || pr.number !== number || pr.state !== 'open' || pr.draft !== false
      || pr.mergeable !== true || pr.base?.ref !== 'main'
      || pr.base?.repo?.id !== id || pr.head?.repo?.id !== id
      || pr.head?.sha !== expected_head) {
    deny('PR_HEAD_OR_MERGE_STATE');
  }
  const author = pr?.user?.login;
  const reviews = snapshot?.reviews;
  if (!Array.isArray(reviews) || reviews.length > 99 || !name_ok(author)) {
    deny('UNTRUSTED_REVIEW_SET');
  } else {
    const latest = new Map();
    for (const r of reviews) {
      const login = r?.user?.login;
      if (!name_ok(login) || !name_ok(r?.state)) { deny('MALFORMED_REVIEW'); continue; }
      // GitHub COMMENTED does not revoke a prior APPROVED/CHANGES_REQUESTED state.
      // DISMISSED and later submitted decisive reviews do supersede it.
      if (r.state !== 'COMMENTED') latest.set(login.toLowerCase(), r);
    }
    // Exactly one of the designated reviewers may approve, but never the author.
    // The diagnostic remains advisory and cannot authorize merging.
    const approved = ['oresoftware', 'the1mills'].some(login => {
      const r = latest.get(login);
      return login !== author.toLowerCase()
        && r?.state === 'APPROVED' && r.commit_id === expected_head;
    });
    if (!approved) deny('MISSING_INDEPENDENT_EXACT_HEAD_APPROVAL');
    if ([...latest.values()].some(r => r.state === 'CHANGES_REQUESTED')) {
      deny('OUTSTANDING_CHANGE_REQUEST');
    }
  }
  const runs = snapshot?.runs;
  if (!Array.isArray(runs) || runs.length === 0 || runs.length > 99) {
    deny('UNBOUNDED_OR_MISSING_WORKFLOW_EVIDENCE');
  } else {
    const seen = new Set();
    for (const entry of runs) {
      const run = entry?.run;
      const jobs = entry?.jobs;
      if (!run || !Number.isSafeInteger(run.id) || run.id < 1 || seen.has(run.id)
          || run.head_sha !== expected_head || run.event !== 'pull_request'
          || run.status !== 'completed' || run.conclusion !== 'success'
          || run.repository?.id !== id || run.head_repository?.id !== id
          || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) {
        deny('UNVERIFIED_SOURCE_WORKFLOW');
      }
      if (run?.id) seen.add(run.id);
      if (!Array.isArray(jobs) || jobs.length === 0 || jobs.length > 99) {
        deny('MISSING_EXECUTED_JOBS');
        continue;
      }
      const jobIds = new Set();
      const jobNames = new Set();
      for (const job of jobs) {
        if (!job || !Number.isSafeInteger(job.id) || job.id < 1
            || jobIds.has(job.id) || job.run_id !== run?.id
            || job.run_attempt !== run?.run_attempt || job.head_sha !== expected_head
            || job.status !== 'completed' || job.conclusion !== 'success'
            || !Number.isSafeInteger(job.runner_id) || job.runner_id <= 0
            || !name_ok(job.runner_name) || !name_ok(job.name)) {
          deny('UNVERIFIED_JOB_OR_RUNNER');
        }
        if (job?.id) jobIds.add(job.id);
        if (name_ok(job?.name)) {
          const key = job.name.toLowerCase();
          if (jobNames.has(key)) deny('DUPLICATE_JOB_NAME');
          jobNames.add(key);
        }
        const steps = job?.steps;
        if (!Array.isArray(steps) || steps.length === 0 || steps.length > 200
            || !steps.some(s => s && meaningful(s.name)
              && s.status === 'completed' && s.conclusion === 'success')
            || steps.some(s => !s || !name_ok(s.name)
              || s.status !== 'completed' || s.conclusion !== 'success')) {
          deny('UNEXECUTED_OR_INVALID_STEPS');
        }
      }
    }
  }
  return {
    schema: 'atto-source-merge-diagnostic-v1', backend, repo: slug,
    pr: number, expected_head,
    decision: failures.length ? 'BLOCKED' : 'REQUIRES_INDEPENDENT_RELEASE_REVIEW',
    failures,
    // Deliberately never authorize a GitHub merge or private-source export.
    merge_authorized: false, private_source_export_authorized: false,
    guest_parity_certified: false,
  };
}

const API_ROOT = 'https://api.github.com/';
async function gh_json(path, token) {
  if (!/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/|$)/.test(path)
      || path.includes('..') || path.includes('//')) throw new Error('invalid API path');
  const response = await fetch(API_ROOT + path, {
    headers: {Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token, 'X-GitHub-Api-Version': '2022-11-28'},
    redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  if (response.status !== 200) throw new Error('GitHub API HTTP ' + response.status);
  return read_strict_github_response(response,
    {allowArray: path.endsWith('/reviews?per_page=100')});
}

export async function inspect_live(backend, number, expected_head, get = gh_json,
    token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
  if (!own(REPOS, backend) || !Number.isSafeInteger(number) || number < 1
      || !SHA.test(expected_head)) throw new TypeError('invalid CLI arguments');
  if (!token && get === gh_json) throw new Error('read-only GitHub token unavailable');
  const [slug] = REPOS[backend];
  const prefix = 'repos/' + slug + '/';
  const [repo, main, pr, reviewPage, runPage] = await Promise.all([
    get(prefix.slice(0, -1), token), get(prefix + 'branches/main', token),
    get(prefix + 'pulls/' + number, token),
    get(prefix + 'pulls/' + number + '/reviews?per_page=100', token),
    get(prefix + 'actions/runs?head_sha=' + expected_head + '&event=pull_request&per_page=100', token),
  ]);
  if (!Array.isArray(reviewPage) || reviewPage.length >= 100
      || !Array.isArray(runPage?.workflow_runs)
      || !Number.isSafeInteger(runPage.total_count)
      || runPage.total_count !== runPage.workflow_runs.length
      || runPage.total_count >= 100) {
    throw new Error('review/workflow pagination cannot be proven complete');
  }
  const runs = [];
  for (const run of runPage.workflow_runs) {
    // Fetch only successful run jobs. A failed run blocks the decision anyway.
    if (run.status !== 'completed' || run.conclusion !== 'success') {
      runs.push({run, jobs: []});
      continue;
    }
    const page = await get(prefix + 'actions/runs/' + run.id + '/jobs?per_page=100', token);
    if (!Array.isArray(page.jobs) || page.total_count !== page.jobs.length
        || page.total_count >= 100) throw new Error('incomplete job pagination');
    runs.push({run, jobs: page.jobs});
  }
  // GitHub's individual GETs are not an atomic snapshot. Fencing the
  // evidence at both ends prevents a changed PR, reviewer, or main state
  // from being mistaken for an exact-head admission result.
  const [repoAfter, mainAfter, prAfter, reviewsAfter] = await Promise.all([
    get(prefix.slice(0, -1), token),
    get(prefix + 'branches/main', token),
    get(prefix + 'pulls/' + number, token),
    get(prefix + 'pulls/' + number + '/reviews?per_page=100', token),
  ]);
  const repoIdentity = r => [r?.id, r?.full_name, r?.private, r?.archived, r?.disabled];
  const mainIdentity = m => [m?.name, m?.protected, m?.commit?.sha];
  const prIdentity = p => [p?.number, p?.state, p?.draft, p?.mergeable,
    p?.base?.ref, p?.base?.sha, p?.base?.repo?.id, p?.head?.sha,
    p?.head?.repo?.id, p?.user?.login];
  const reviewIdentity = rs => rs.map(r => [r?.id, r?.user?.login,
    r?.state, r?.commit_id, r?.submitted_at]);
  if (!SHA.test(main?.commit?.sha || '') || !SHA.test(pr?.base?.sha || '')
      || !Array.isArray(reviewsAfter) || reviewsAfter.length >= 100
      || JSON.stringify(repoIdentity(repo)) !== JSON.stringify(repoIdentity(repoAfter))
      || JSON.stringify(mainIdentity(main)) !== JSON.stringify(mainIdentity(mainAfter))
      || JSON.stringify(prIdentity(pr)) !== JSON.stringify(prIdentity(prAfter))
      || JSON.stringify(reviewIdentity(reviewPage)) !== JSON.stringify(reviewIdentity(reviewsAfter))) {
    throw new Error('source PR, main, repository, or review drift during evidence capture');
  }
  return assess({repo: repoAfter, main: mainAfter, pr: prAfter,
    reviews: reviewsAfter, runs}, backend, number, expected_head);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [backend, raw_number, expected_head] = process.argv.slice(2);
  const number = Number(raw_number);
  try {
    const result = await inspect_live(backend, number, expected_head);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exitCode = result.decision === 'BLOCKED' ? 2 : 0;
  } catch (e) {
    process.stderr.write('MERGE_DIAGNOSTIC_UNVERIFIED: ' + e.message + '\n');
    process.exitCode = 3;
  }
}
