# Exact GitHub Actions run evidence contract v1 — five Oreslang source backends

This repository carries **the same** `scripts/verify_ci_run.py` and
`scripts/test_verify_ci_run.py` as `oreslang-source.java`, `.llvm`, `.net`,
`.wasm`, and `.forge`. The helper is read-only: it never publishes Git objects,
checks out private source, starts workflows, or changes repository policy.

## Purpose

The verifier checks that a **real GitHub Actions run** corresponds to a
specific immutable commit and its actual Git tree **and approved workflow file path**, in one of the five exact
private repositories with pinned numeric repository IDs. It independently
fetches the repository, commit, run and *all* Actions jobs through GitHub's
read-only API. It rejects nonprivate/mismatched/archived identities, wrong
commit/tree, foreign run/head repository, wrong run SHA, foreign/missing workflow path, uncompleted/failed
runs, missing/failed/skipped jobs, zero-step jobs, missing or stale run-attempt IDs, missing expected jobs or
expected executable steps, ambiguous duplicate job names, missing/zero/noninteger
runner IDs, blank runner names and truncated job pagination.
Housekeeping-only steps are not proof of meaningful execution. A required
proof step must itself be executable: GitHub runner lifecycle names such as
`Set up job`, `Complete job`, `Post ...`, `Pre ...`, and container setup/
teardown are **invalid proof requirements**, even when some unrelated command
succeeded in the same job. A required step must belong to a named **required
job**; an unrelated job cannot satisfy it. With multiple named jobs, explicit per-job step bindings are mandatory: a
passing step in job A may not stand in for the required test step in job B.

This is a **run execution and Git provenance check**, not proof that all
expected tests executed, or a guest-runtime feature-parity certification.
It does not independently inspect JUnit, CTest, `dotnet test`, Node/Rust,
AOT output, test logs, coverage, cancellation accounting or build artifacts.
Those require separate backend-native assertions and logs. Never infer a
candidate's tree from a successful `workflow_dispatch` run targeting a
*workflow on main*: a run's `head_sha` may identify the trusted workflow,
**not** a different commit checked out inside the job. The verifier checks
only the run's own `head_sha`. For manually dispatched exact-candidate jobs,
record and verify the target commit/tree inside the *trusted workflow* too.

## Commands

```bash
python3 scripts/test_verify_ci_run.py

# Example: exact-head source run; replace placeholders with GitHub-confirmed values.
GH_TOKEN="$READ_ONLY_GITHUB_TOKEN" python3 scripts/verify_ci_run.py \
  --backend llvm --commit "$EXACT_RUN_HEAD_SHA" --tree "$EXACT_RUN_HEAD_TREE" \
  --run-id "$RUN_ID" --workflow-path ".github/workflows/ci.yml" \
  --workflow-id "$INDEPENDENTLY_PINNED_NUMERIC_WORKFLOW_ID" \
  --workflow-blob-sha "$INDEPENDENTLY_PINNED_WORKFLOW_GIT_BLOB_SHA" \
  --require-job 'test' --require-step 'Run CTest'
```

For multi-job validation, enumerate each required job, each required step, and
bind the exact combinations using repeated `--require-job-step 'JOB::STEP'`
arguments. For example, `--require-job 'unit' --require-job 'native'
--require-step 'Run pytest' --require-step 'Run CTest'
--require-job-step 'unit::Run pytest' --require-job-step 'native::Run CTest'`.
Missing, duplicated, or cross-job substituted bindings are rejected.

A trusted release controller must supply `--workflow-path` from an independently
reviewed policy, **never by copying `run.path` from the candidate's response**.
The verifier rejects empty, malformed, traversal, ambiguous or unapproved paths,
and requires the actual GitHub run's `path` to identify the supplied
`.github/workflows/*.yml` or `*.yaml` file exactly. The GitHub REST API may
append an `@ref` qualifier (for example,
`.github/workflows/ci.yml@main` or `@refs/pull/123/merge`); the verifier
accepts a well-formed qualifier but rejects suffix-sharing filenames, empty
qualifiers, traversal and malformed ref spellings. This ties evidence to the expected workflow **filename**. The mandatory
independently pinned `--workflow-blob-sha` additionally verifies the YAML Git
blob at the run HEAD. Neither check proves which workflow ref GitHub actually
executed for a different event context, or which sources a job checked out.
Branch protection, executed-workflow-ref attestation, and source export policy
remain separate mandatory gates.

Supported `--backend`: `java`, `llvm`, `net`, `wasm`, `forge`. Run it inside a
trusted local environment or a **reviewed** source-scoped CI workflow with a
read-only token. The GitHub Actions token must have adequate `actions: read`
and `contents: read` access; no cross-organization checkout is needed.
Success produces a machine-readable statement
`GITHUB_RUN_EXECUTION_VERIFIED_NOT_GUEST_PARITY_CERTIFIED`. Failure returns
nonzero and a `CI_RUN_EVIDENCE_REJECTED` explanation without printing tokens.

## Security and release boundaries

* Source `main` branch protection, independent review, and policy approval
  are **separate gates**. This checker is **not** authorization to export private
  source to a funded carrier.
* Historical successful runs prove neither current Actions budget nor
  suitability to receive private source.
* Zero-step `failure` or `success` is never evidence of tests executing.
  Every completed-success job must also report a positive numeric `runner_id`
  and a nonempty `runner_name`. This checks actual allocation metadata,
  not that the requested compiler binary ran or that the runner is trusted.
* Run SHA/tree and required job/step names must be selected from independently
  reviewed release policy; untrusted candidates cannot choose easy smoke jobs.
* For backend parity, require the **same semantic test vector IDs and behavior**
  plus native backend-specific build/toolchain verification on each of the five
  backends. This script alone does not provide runtime parity.
* Never merge based solely on the test verifier's mocked self-tests. Only
  real backend-native CI and independent security review can promote a PR.

## Independently pinned workflow identity and ambiguous-step rejection

The verifier also requires `--workflow-id <positive-int>` chosen from trusted,
independently reviewed policy and compares it to GitHub's numeric
`run.workflow_id`. **Do not populate this option by blindly copying it
from the run being verified**. This is additional workflow identity evidence,
not verification of the workflow YAML bytes or of which source the workflow
checked out. Check workflow contents, source HEAD and tree separately.

The verifier denies duplicate step names within a job, because two steps
with the same display name cannot unambiguously satisfy a named proof step.
All required jobs and steps must be explicit sequences; malformed caller
inputs deny verification. These guards are checked by at least 54 independent
source-free regression cases, three times in the CI workflow. The
regressions are not native Oreslang compiler or runtime conformance tests.

Example invocation now includes:

```bash
python3 scripts/verify_ci_run.py --backend java \
  --commit "$PINNED_HEAD_SHA" --tree "$PINNED_GIT_TREE_SHA" \
  --run-id "$GITHUB_RUN_ID" \
  --workflow-path ".github/workflows/ci-run-evidence-contract.yml" \
  --workflow-id "$INDEPENDENTLY_PINNED_NUMERIC_WORKFLOW_ID" \
  --workflow-blob-sha "$INDEPENDENTLY_PINNED_WORKFLOW_GIT_BLOB_SHA" \
  --require-job "exact-run-evidence-contract" \
  --require-step "Run all five-backend source-free security regressions"
```

These checks do not authorize private-source cross-organization mirroring.
Actual compiler source transfer remains blocked by independent protected-main
policy approval and the open incident containment actions.

## Workflow-content and job-HEAD pins

`--workflow-blob-sha` is mandatory and comes from independently reviewed
policy, **never from the candidate run**. It is compared to the GitHub Contents
API blob at the exact run HEAD, with file type and path checked. Each job's
`head_sha` must also match that same exact run HEAD. This still does not prove
that GitHub executed the same YAML bytes when the event uses an alternate
base ref; controllers must attest the executed workflow ref separately.
These checks do not authorize private source export or certify native parity.

## Run-attempt consistency hardening

After checking all paginated job/step evidence, the verifier fetches the run
metadata again and rejects a changed attempt, completion result, HEAD SHA,
workflow ID/path or repository identity. This guards against combining
successful run metadata with jobs fetched across a rerun. The re-read is
not an atomic GitHub API snapshot; release controllers should pin a finished
attempt and independently examine the archived native test artifacts.

The source-free regression suite contains at least 55 unittest methods and is
executed for three rounds when GitHub Actions runners are available. Passing
these tests alone does not establish that any backend-native tests ran.
