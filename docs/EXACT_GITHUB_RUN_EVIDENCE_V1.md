# Exact GitHub Actions run evidence contract v1 — five Oreslang source backends

This repository carries **the same** `scripts/verify_ci_run.py` and
`scripts/test_verify_ci_run.py` as `oreslang-source.java`, `.llvm`, `.net`,
`.wasm`, and `.forge`. The helper is read-only: it never publishes Git objects,
checks out private source, starts workflows, or changes repository policy.

## Purpose

The verifier checks that a **real GitHub Actions run** corresponds to a
specific immutable commit and its actual Git tree, in one of the five exact
private repositories with pinned numeric repository IDs. It independently
fetches the repository, commit, run and *all* Actions jobs through GitHub's
read-only API. It rejects nonprivate/mismatched/archived identities, wrong
commit/tree, foreign run/head repository, wrong run SHA, uncompleted/failed
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
  --run-id "$RUN_ID" --require-job 'test' --require-step 'Run CTest'
```

For multi-job validation, enumerate each required job, each required step, and
bind the exact combinations using repeated `--require-job-step 'JOB::STEP'`
arguments. For example, `--require-job 'unit' --require-job 'native'
--require-step 'Run pytest' --require-step 'Run CTest'
--require-job-step 'unit::Run pytest' --require-job-step 'native::Run CTest'`.
Missing, duplicated, or cross-job substituted bindings are rejected.

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
