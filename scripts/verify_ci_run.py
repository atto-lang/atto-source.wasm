#!/usr/bin/env python3
"""Read-only GitHub evidence check for the same exact Git commit across Oreslang backends.

This confirms real *GitHub job execution*, not guest semantics or test coverage.
It never copies source, triggers CI, or mutates GitHub state.
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

REPOS = {
    "java": ("ores-truffle-oreslang/oreslang-source.java", 1400792274),
    "llvm": ("ores-truffle-oreslang/oreslang-source.llvm", 1410897874),
    "net": ("ores-truffle-oreslang/oreslang-source.net", 1419704375),
    "wasm": ("ores-truffle-oreslang/oreslang-source.wasm", 1419858954),
    "forge": ("ores-truffle-oreslang/oreslang-source.forge", 1419703674),
}
SHA = re.compile(r"^[0-9a-f]{40}$")
MAX_PAGES = 10
HOUSEKEEPING_STEPS = frozenset({
    "Set up job", "Complete job", "Initialize containers",
    "Start containers", "Stop containers",
})


def executable_step_name(name):
    # Runner-generated lifecycle steps cannot substitute for a required
    # build, test, or native guest-execution step.
    return (isinstance(name, str) and name not in HOUSEKEEPING_STEPS
            and not name.startswith(("Post ", "Pre ")))


class Denied(ValueError):
    """Fail-closed verification: this run cannot support a CI execution claim."""


def _sha(value):
    if not isinstance(value, str) or not SHA.fullmatch(value):
        raise Denied("expected a lowercase 40-digit commit/tree SHA")
    return value


def _object(value, label):
    if not isinstance(value, dict):
        raise Denied(label + " is not a JSON object")
    return value


def _int(value, label):
    if type(value) is not int or value <= 0:
        raise Denied(label + " is not a positive integer")
    return value


def _api_get(path):
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not token:
        raise Denied("a read-only GitHub API token is required")
    if not path.startswith("repos/") or ".." in path or "//" in path:
        raise Denied("invalid GitHub API resource")
    req = urllib.request.Request(
        "https://api.github.com/" + path,
        headers={"Accept": "application/vnd.github+json",
                 "Authorization": "Bearer " + token,
                 "X-GitHub-Api-Version": "2022-11-28",
                 "User-Agent": "oreslang-exact-ci-evidence-v1"},
        method="GET")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            if resp.status != 200:
                raise Denied("GitHub API did not return HTTP 200")
            raw = resp.read(4 * 1024 * 1024 + 1)
    except (OSError, urllib.error.HTTPError, urllib.error.URLError) as exc:
        raise Denied("authenticated GitHub API query failed") from exc
    if len(raw) > 4 * 1024 * 1024:
        raise Denied("GitHub response too large")
    try:
        return _object(json.loads(raw), "GitHub API response")
    except (ValueError, UnicodeError) as exc:
        raise Denied("malformed GitHub JSON response") from exc


def verify(fetch, backend, commit, tree, run_id, required_jobs, required_steps,
           job_step_pairs=None):
    """Return evidence summary, or reject. `fetch` must query the real GitHub API.

    This is an independently verifiable *run execution* proof for its run HEAD.
    Workflow-dispatch runs that check out a DIFFERENT candidate cannot use the
    workflow HEAD's success as an attestation of that candidate.
    """
    if backend not in REPOS:
        raise Denied("unrecognized Oreslang backend")
    repo, repo_id = REPOS[backend]
    commit, tree, run_id = _sha(commit), _sha(tree), _int(run_id, "run id")
    if not required_jobs or not required_steps:
        raise Denied("explicit job and executable step names are required")
    if any(not isinstance(x, str) or not x.strip() or len(x) > 180
           for x in [*required_jobs, *required_steps]):
        raise Denied("invalid required job or step name")
    if len(set(required_jobs)) != len(required_jobs) or len(set(required_steps)) != len(required_steps):
        raise Denied("duplicate required CI proof name")
    if any(not executable_step_name(step) for step in required_steps):
        raise Denied("required CI step must not be runner housekeeping")
    # Binding a test step to the specific required job prevents a passing
    # unrelated job from laundering a required suite's execution evidence.
    pairs = [] if job_step_pairs is None else job_step_pairs
    if not isinstance(pairs, list):
        raise Denied("job-step binding requirements must be a list")
    if len(required_jobs) > 1 and not pairs:
        raise Denied("multiple required jobs need explicit job-step bindings")
    if len(pairs) > 100:
        raise Denied("too many job-step binding requirements")
    for pair in pairs:
        if (not isinstance(pair, tuple) or len(pair) != 2
                or pair[0] not in required_jobs or pair[1] not in required_steps):
            raise Denied("invalid required job-step binding")
    if len(set(pairs)) != len(pairs):
        raise Denied("duplicate required job-step binding")
    if pairs and (set(job for job, _ in pairs) != set(required_jobs)
                  or not set(required_steps).issubset(step for _, step in pairs)):
        raise Denied("all required jobs and steps must have explicit bindings")
    prefix = "repos/" + repo
    meta = _object(fetch(prefix), "repository")
    if (type(meta.get("id")) is not int or meta["id"] != repo_id
            or meta.get("full_name") != repo
            or meta.get("private") is not True
            or meta.get("archived") is not False
            or meta.get("disabled") is not False):
        raise Denied("GitHub repository identity/visibility mismatch")
    c = _object(fetch(prefix + "/git/commits/" + commit), "commit")
    if c.get("sha") != commit or _object(c.get("tree"), "Git commit tree").get("sha") != tree:
        raise Denied("source commit does not point to supplied exact tree")
    run = _object(fetch(prefix + "/actions/runs/" + str(run_id)), "workflow run")
    run_repo = _object(run.get("repository"), "run repository")
    head_repo = _object(run.get("head_repository"), "run head repository")
    attempt = _int(run.get("run_attempt"), "run attempt")
    if (type(run.get("id")) is not int or run["id"] != run_id
            or type(run_repo.get("id")) is not int or run_repo["id"] != repo_id
            or type(head_repo.get("id")) is not int or head_repo["id"] != repo_id
            or run.get("head_sha") != commit
            or run.get("status") != "completed"
            or run.get("conclusion") != "success"):
        raise Denied("workflow run is not a successful exact-repository HEAD execution")
    jobs = []
    total = None
    for page in range(1, MAX_PAGES + 1):
        payload = _object(fetch(prefix + "/actions/runs/" + str(run_id)
                                + "/jobs?filter=latest&per_page=100&page=" + str(page)),
                          "workflow jobs")
        reported_total = payload.get("total_count")
        if type(reported_total) is not int or reported_total < 1 or reported_total > 1000:
            raise Denied("workflow jobs total is invalid or excessive")
        if total is None:
            total = reported_total
        elif total != reported_total:
            raise Denied("workflow job pages disagree on count")
        found = payload.get("jobs")
        if not isinstance(found, list) or len(found) > 100:
            raise Denied("workflow jobs page malformed")
        jobs.extend(found)
        if len(jobs) >= total:
            break
        if len(found) != 100:
            raise Denied("incomplete GitHub Actions job pagination")
    if not jobs or len(jobs) != total:
        raise Denied("not all GitHub Actions jobs were retrieved")
    seen_ids, job_names, required_job_steps = set(), set(), set()
    steps_by_job = {}
    count = 0
    for item in jobs:
        job = _object(item, "workflow job")
        job_id = _int(job.get("id"), "job id")
        if job_id in seen_ids:
            raise Denied("duplicated workflow job id")
        seen_ids.add(job_id)
        if (job.get("run_id") != run_id or
                type(job.get("run_attempt")) is not int or job["run_attempt"] != attempt
                or job.get("status") != "completed" or job.get("conclusion") != "success"):
            raise Denied("workflow contains a failed, skipped, or unexecuted job")
        # A successful workflow record with no actual runner allocation is
        # not execution evidence. GitHub reports runner_id=0 or null, and a
        # blank runner_name, for failed-before-start infrastructure jobs.
        if (type(job.get("runner_id")) is not int
                or job["runner_id"] <= 0
                or not isinstance(job.get("runner_name"), str)
                or not job["runner_name"].strip()):
            raise Denied("workflow job lacks a real allocated runner")
        name = job.get("name")
        if not isinstance(name, str) or not name:
            raise Denied("missing workflow job name")
        if name in job_names:
            raise Denied("ambiguous repeated workflow job name")
        job_names.add(name)
        steps_by_job[name] = set()
        steps = job.get("steps")
        if not isinstance(steps, list) or not steps:
            raise Denied("workflow job has zero executed steps")
        ran_useful_step = False
        for item_step in steps:
            step = _object(item_step, "workflow step")
            if step.get("status") != "completed" or step.get("conclusion") != "success":
                raise Denied("workflow step was not completed successfully")
            step_name = step.get("name")
            if not isinstance(step_name, str) or not step_name:
                raise Denied("workflow step has no name")
            if name in required_jobs:
                required_job_steps.add(step_name)
                steps_by_job[name].add(step_name)
            if executable_step_name(step_name):
                ran_useful_step = True
                count += 1
        if not ran_useful_step:
            raise Denied("workflow job only executed runner housekeeping")
    if not set(required_jobs).issubset(job_names):
        raise Denied("required workflow job is missing")
    if not set(required_steps).issubset(required_job_steps):
        raise Denied("required executable CI step is missing")
    if pairs and any(step not in steps_by_job.get(job, set())
                     for job, step in pairs):
        raise Denied("required executable step did not run in its bound CI job")
    return {"backend": backend, "repository": repo, "repository_id": repo_id,
            "run_id": run_id, "run_attempt": attempt, "head_commit": commit,
            "head_tree": tree, "verified_jobs": len(jobs),
            "successful_non_housekeeping_steps": count,
            "statement": "GITHUB_RUN_EXECUTION_VERIFIED_NOT_GUEST_PARITY_CERTIFIED"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", required=True, choices=sorted(REPOS))
    parser.add_argument("--commit", required=True)
    parser.add_argument("--tree", required=True)
    parser.add_argument("--run-id", required=True, type=int)
    parser.add_argument("--require-job", action="append", default=[])
    parser.add_argument("--require-step", action="append", default=[])
    parser.add_argument("--require-job-step", action="append", default=[],
                        metavar="JOB::STEP",
                        help="Require this exact step inside this exact job")
    args = parser.parse_args(argv)
    try:
        pairs = []
        for binding in args.require_job_step:
            if "::" not in binding:
                raise Denied("job-step binding must use JOB::STEP")
            pair = tuple(binding.split("::", 1))
            pairs.append(pair)
        result = verify(_api_get, args.backend, args.commit, args.tree,
                        args.run_id, args.require_job, args.require_step,
                        job_step_pairs=pairs)
    except Denied as exc:
        print("CI_RUN_EVIDENCE_REJECTED: " + str(exc), file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
