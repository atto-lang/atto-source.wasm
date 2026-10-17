#!/usr/bin/env python3
"""Read-only GitHub evidence check for the same exact Git commit across Oreslang backends.

This confirms real *GitHub job execution*, not guest semantics or test coverage.
It never copies source, triggers CI, or mutates GitHub state.
"""
import argparse
from datetime import datetime
import json
import math
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
    "rx_pull": ("ores-truffle-oreslang/rx-ores", 1407870560),
    "rx_callbacks": ("ores-truffle-oreslang/rx-ores-callbacks", 1407871059),
    "rx_channels": ("ores-truffle-oreslang/rx-oreslang-channels", 1407757001),
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
    if not isinstance(name, str):
        return False
    normalized = name.strip().casefold()
    # A blank or disguised runner-generated step is not build/test execution.
    # Normalize padding and case before excluding housekeeping and pre/post.
    return (bool(normalized)
            and normalized not in {step.casefold() for step in HOUSEKEEPING_STEPS}
            and re.match(r"^(pre|post)\s", normalized) is None)


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


def _run_workflow_path_matches(actual, expected):
    # GitHub returns workflow run 'path' as .github/workflows/foo.yml@main
    # or with a refs/* qualifier (see the REST example). Match the exact
    # trusted workflow *file*, not a suffix-sharing or arbitrary URL path.
    if not isinstance(actual, str):
        return False
    if actual == expected:
        return True
    prefix = expected + "@"
    if not actual.startswith(prefix):
        return False
    ref = actual[len(prefix):]
    return bool(re.fullmatch(r"[A-Za-z0-9_./-]+", ref)
                and not any(p in ("", ".", "..") for p in ref.split("/")))


def _timestamp(value, label):
    # GitHub Actions reports UTC RFC3339 second-precision timestamps.
    if not isinstance(value, str) or not re.fullmatch(
            r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z", value):
        raise Denied(label + " lacks a UTC execution timestamp")
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError as exc:
        raise Denied(label + " has an invalid execution timestamp") from exc


MAX_API_JSON_BYTES = 4 * 1024 * 1024


def _strict_api_json(raw):
    # GitHub evidence must not depend on Python's permissive last-key-wins
    # parser, JavaScript-only nonfinite numbers, or lossy giant numeric tokens.
    if not isinstance(raw, bytes) or len(raw) > MAX_API_JSON_BYTES:
        raise Denied("GitHub API JSON response is missing or oversized")

    def unique_keys(pairs):
        result = {}
        for name, value in pairs:
            if name in result:
                raise Denied("GitHub API JSON has duplicate object keys")
            result[name] = value
        return result

    def no_constant(value):
        raise Denied("GitHub API JSON contains a nonstandard number")

    def strict_int(value):
        if len(value) > 64:
            raise Denied("GitHub API JSON integer is oversized")
        return int(value)

    def strict_float(value):
        if len(value) > 128:
            raise Denied("GitHub API JSON floating-point token is oversized")
        number = float(value)
        if not math.isfinite(number):
            raise Denied("GitHub API JSON contains a nonfinite number")
        return number

    try:
        data = json.loads(raw, object_pairs_hook=unique_keys,
                          parse_constant=no_constant, parse_int=strict_int,
                          parse_float=strict_float)
    except Denied:
        # Denied derives from ValueError; retain the precise security failure
        # instead of disguising duplicate/nonfinite metadata as generic JSON.
        raise
    except (UnicodeError, ValueError, OverflowError, RecursionError) as exc:
        raise Denied("malformed GitHub API JSON response") from exc
    return _object(data, "GitHub API response")


class _DenyRedirects(urllib.request.HTTPRedirectHandler):
    """Never forward GitHub API credentials to another redirect target.

    urllib's default redirect handler forwards Request Authorization headers,
    including to another host. API evidence must come from api.github.com.
    """
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise Denied("authenticated GitHub API redirect denied")


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
        with urllib.request.build_opener(_DenyRedirects).open(req, timeout=20) as resp:
            if resp.status != 200:
                raise Denied("GitHub API did not return HTTP 200")
            raw = resp.read(4 * 1024 * 1024 + 1)
    except (OSError, urllib.error.HTTPError, urllib.error.URLError) as exc:
        raise Denied("authenticated GitHub API query failed") from exc
    return _strict_api_json(raw)


def verify(fetch, backend, commit, tree, run_id, required_jobs, required_steps,
           job_step_pairs=None, workflow_path=None, workflow_id=None,
           workflow_blob_sha=None, expected_event=None,
           expected_run_path=None, expected_run_attempt=None):
    """Return evidence summary, or reject. `fetch` must query the real GitHub API.

    This is an independently verifiable *run execution* proof for its run HEAD.
    Workflow-dispatch runs that check out a DIFFERENT candidate cannot use the
    workflow HEAD's success as an attestation of that candidate.
    """
    if backend not in REPOS:
        raise Denied("unrecognized Oreslang backend")
    repo, repo_id = REPOS[backend]
    commit, tree, run_id = _sha(commit), _sha(tree), _int(run_id, "run id")
    if (not isinstance(workflow_path, str)
            or not re.fullmatch(r"\.github/workflows/[A-Za-z0-9._/-]+\.ya?ml", workflow_path)
            or any(part in ("", ".", "..") for part in workflow_path.split("/"))):
        raise Denied("expected an exact trusted workflow path under .github/workflows")
    workflow_id = _int(workflow_id, "independently pinned workflow id")
    expected_run_attempt = _int(expected_run_attempt, "independently pinned run attempt")
    workflow_blob_sha = _sha(workflow_blob_sha)
    if not _run_workflow_path_matches(expected_run_path, workflow_path):
        raise Denied("expected independently pinned exact workflow run path")
    if expected_event not in ("push", "pull_request"):
        raise Denied("only independently selected push or pull_request event is permitted")
    if not isinstance(required_jobs, (list, tuple)) or not isinstance(required_steps, (list, tuple)):
        raise Denied("required CI job and step names must be sequences")
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
    # Bind a separately reviewed workflow blob to this exact source HEAD.
    wf = _object(fetch(prefix + "/contents/" + workflow_path + "?ref=" + commit),
                 "pinned workflow file")
    if (wf.get("type") != "file" or wf.get("path") != workflow_path
            or wf.get("sha") != workflow_blob_sha):
        raise Denied("workflow blob differs from independently reviewed SHA")
    run = _object(fetch(prefix + "/actions/runs/" + str(run_id)), "workflow run")
    run_repo = _object(run.get("repository"), "run repository")
    head_repo = _object(run.get("head_repository"), "run head repository")
    attempt = _int(run.get("run_attempt"), "run attempt")
    if attempt != expected_run_attempt:
        raise Denied("run attempt differs from independently pinned attempt")
    if (type(run.get("id")) is not int or run["id"] != run_id
            or type(run_repo.get("id")) is not int or run_repo["id"] != repo_id
            or type(head_repo.get("id")) is not int or head_repo["id"] != repo_id
            or run.get("head_sha") != commit
            or run.get("event") != expected_event
            or type(run.get("workflow_id")) is not int or run["workflow_id"] != workflow_id
            or run.get("path") != expected_run_path
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
        if (type(job.get("run_id")) is not int or job["run_id"] != run_id or
                job.get("head_sha") != commit or
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
        job_start = _timestamp(job.get("started_at"), "job start")
        job_end = _timestamp(job.get("completed_at"), "job completion")
        if job_end < job_start:
            raise Denied("workflow job completion precedes its start")
        name = job.get("name")
        if not isinstance(name, str) or not name.strip():
            raise Denied("missing workflow job name")
        if name in job_names:
            raise Denied("ambiguous repeated workflow job name")
        job_names.add(name)
        steps_by_job[name] = set()
        steps = job.get("steps")
        if not isinstance(steps, list) or not steps:
            raise Denied("workflow job has zero executed steps")
        ran_useful_step = False
        seen_step_names = set()
        last_number = 0
        previous_step_end = job_start
        for item_step in steps:
            step = _object(item_step, "workflow step")
            if step.get("status") != "completed" or step.get("conclusion") != "success":
                raise Denied("workflow step was not completed successfully")
            number = _int(step.get("number"), "step number")
            if number <= last_number:
                raise Denied("workflow steps have duplicate or out-of-order numbers")
            last_number = number
            step_start = _timestamp(step.get("started_at"), "step start")
            step_end = _timestamp(step.get("completed_at"), "step completion")
            if not (job_start <= step_start <= step_end <= job_end):
                raise Denied("workflow step timing falls outside completed job")
            if step_start < previous_step_end:
                raise Denied("workflow step timestamps overlap or contradict execution order")
            previous_step_end = step_end
            step_name = step.get("name")
            if not isinstance(step_name, str) or not step_name.strip():
                raise Denied("workflow step has no name")
            if step_name in seen_step_names:
                raise Denied("ambiguous duplicate workflow step name in job")
            seen_step_names.add(step_name)
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
    # Detect a re-run or changed conclusion during multi-page evidence collection.
    # Never combine a successful run snapshot with jobs from another attempt.
    final_run = _object(fetch(prefix + "/actions/runs/" + str(run_id)), "final workflow run")
    final_run_repo = _object(final_run.get("repository"), "final run repository")
    final_head_repo = _object(final_run.get("head_repository"), "final head repository")
    if (type(final_run.get("id")) is not int or final_run["id"] != run_id
            or type(final_run.get("run_attempt")) is not int
            or final_run["run_attempt"] != attempt
            or final_run.get("head_sha") != commit
            or final_run.get("event") != expected_event
            or type(final_run.get("workflow_id")) is not int
            or final_run.get("workflow_id") != workflow_id
            or final_run.get("status") != "completed"
            or final_run.get("conclusion") != "success"
            or final_run.get("path") != expected_run_path
            or type(final_run_repo.get("id")) is not int
            or final_run_repo["id"] != repo_id
            or type(final_head_repo.get("id")) is not int
            or final_head_repo["id"] != repo_id):
        raise Denied("workflow run changed during evidence collection")
    # Recheck source repository identity/visibility after collecting all jobs:
    # a rename, replacement, or public visibility transition must not pass
    # using only its earlier preflight metadata.
    final_meta = _object(fetch(prefix), "final repository")
    if (type(final_meta.get("id")) is not int
            or final_meta.get("id") != repo_id
            or final_meta.get("full_name") != repo
            or final_meta.get("private") is not True
            or final_meta.get("archived") is not False
            or final_meta.get("disabled") is not False):
        raise Denied("source repository changed identity or privacy during evidence collection")
    return {"backend": backend, "repository": repo, "repository_id": repo_id,
            "run_id": run_id, "run_attempt": attempt, "workflow_path": workflow_path,
            "workflow_run_path": expected_run_path,
            "event": expected_event,
            "head_commit": commit,
            "head_tree": tree, "workflow_blob_sha": workflow_blob_sha,
            "verified_jobs": len(jobs),
            "successful_non_housekeeping_steps": count,
            "statement": "GITHUB_RUN_EXECUTION_VERIFIED_NOT_GUEST_PARITY_CERTIFIED"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", required=True, choices=sorted(REPOS))
    parser.add_argument("--commit", required=True)
    parser.add_argument("--tree", required=True)
    parser.add_argument("--run-id", required=True, type=int)
    parser.add_argument("--run-attempt", required=True, type=int,
                        help="Independently pinned positive GitHub run attempt number")
    parser.add_argument("--event", required=True, choices=("push", "pull_request"),
                        help="Independently pinned GitHub event type; no dispatch or chained runs")
    parser.add_argument("--workflow-run-path", required=True,
                        help="Exact independently approved GitHub run.path including any @ref")
    parser.add_argument("--workflow-path", required=True,
                        help="Exact independently reviewed .github/workflows/*.yml path")
    parser.add_argument("--workflow-id", required=True, type=int,
                        help="Independently reviewed numeric GitHub workflow ID")
    parser.add_argument("--workflow-blob-sha", required=True,
                        help="Independently reviewed workflow YAML Git blob SHA at run HEAD")
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
                        job_step_pairs=pairs, workflow_path=args.workflow_path,
                        workflow_id=args.workflow_id,
                        workflow_blob_sha=args.workflow_blob_sha,
                        expected_event=args.event,
                        expected_run_path=args.workflow_run_path,
                        expected_run_attempt=args.run_attempt)
    except Denied as exc:
        print("CI_RUN_EVIDENCE_REJECTED: " + str(exc), file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
