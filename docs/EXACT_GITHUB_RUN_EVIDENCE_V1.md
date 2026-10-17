# Exact GitHub Actions run evidence contract v1 — five Oreslang source backends and three Rx variants

This repository carries **the same** `scripts/verify_ci_run.py` and
`scripts/test_verify_ci_run.py` as `oreslang-source.java`, `.llvm`, `.net`,
`.wasm`, and `.forge`. The helper is read-only: it never publishes Git objects,
checks out private source, starts workflows, or changes repository policy.

## Purpose

The verifier checks that a **real GitHub Actions run** corresponds to a
specific immutable commit and its actual Git tree **and approved workflow file path**, in one of eight exact
private repositories (five compiler backends plus three Rx prototypes) with pinned numeric repository IDs. It independently
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

Supported `--backend`: `java`, `llvm`, `net`, `wasm`, `forge`, `rx_pull`, `rx_callbacks`, `rx_channels`. Run it inside a
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
not proof of which source the workflow actually checked out. Separately pin the
workflow YAML Git blob (as this verifier requires), source HEAD and tree.

The verifier denies duplicate step names within a job, because two steps
with the same display name cannot unambiguously satisfy a named proof step.
All required jobs and steps must be explicit sequences; malformed caller
inputs deny verification. These guards are checked by all 73 independently defined source-free
regression cases, three times in the CI workflow. The
regressions are not native Oreslang compiler or runtime conformance tests.

Example invocation now includes:

```bash
python3 scripts/verify_ci_run.py --backend java \
  --commit "$PINNED_HEAD_SHA" --tree "$PINNED_GIT_TREE_SHA" \
  --run-id "$GITHUB_RUN_ID" --run-attempt "$INDEPENDENTLY_PINNED_RUN_ATTEMPT" \
  --event "pull_request" \
  --workflow-path ".github/workflows/ci-run-evidence-contract.yml" \
  --workflow-run-path "$INDEPENDENTLY_PINNED_EXACT_RUN_PATH" \
  --workflow-id "$INDEPENDENTLY_PINNED_NUMERIC_WORKFLOW_ID" \
  --workflow-blob-sha "$INDEPENDENTLY_PINNED_WORKFLOW_GIT_BLOB_SHA" \
  --require-job "exact-run-evidence-contract" \
  --require-step "Run all eight-repository source-free security regressions"
```

These checks do not authorize private-source cross-organization mirroring.
Actual compiler source transfer remains blocked by independent protected-main
policy approval and the open incident containment actions.


## Exact workflow-run ref pinning

`--workflow-path` still identifies the reviewed workflow file inside the
source commit. The new mandatory `--workflow-run-path` specifies the
**exact**, independently approved GitHub Actions `run.path` string, including
a full `@ref` qualifier when GitHub returns one (for example,
`.github/workflows/ci.yml@refs/heads/main`). The verifier compares that
string byte-for-byte with both the initial and final run responses.
An otherwise valid run for `ci.yml@refs/heads/unreviewed` **cannot**
satisfy a pin for `ci.yml@refs/heads/main`.

A file-only match or a workflow blob from the candidate tree cannot prove
that an alternate ref actually executed the reviewed workflow. Obtain this
pin from trusted review policy, never by copying the candidate response's
`path`. Valid documented unqualified run paths can be pinned exactly;
no qualified/unqualified fallback is allowed. This does not change the
need to inspect native guest results, source privacy, or branch protection.

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

The exact run event is also **mandatory and independently selected** using
`--event push` or `--event pull_request`. The verifier rejects workflows
triggered by `workflow_dispatch`, `workflow_run`, `pull_request_target`,
`schedule`, `repository_dispatch`, or other events; an alternate trigger
cannot launder the same completed job and step names as an approved
push/PR execution. The event is rechecked after jobs are collected to
detect an inconsistent run snapshot. This deliberately excludes manually
dispatched carrier jobs from **source-HEAD** certification. Approved
private test-carrier execution and exact guest snapshot evidence must
be attested separately under the source-export policy; a successful
carrier run cannot certify a different source repository's commit.

The source-free regression suite defines 73 unittest methods, and the workflow
requires at least 73 per round in three rounds when Actions runners are available. Passing
these tests alone does not establish that any backend-native tests ran.

## Short-lived Actions evidence artifact

The identical `.github/workflows/ci-run-evidence-contract.yml` in all eight
source repositories captures the expected pull-request HEAD, exact checked-out Git
commit/tree, repository ID, runner name and the source-free regression-step
outcome. It attempts to upload a **three-day-retention**, metadata-only
`source-free-ci-evidence-<run-id>-<attempt>` artifact, including when a
regression fails; it does **not** upload private compiler source or binaries.

The JSON intentionally includes `verified_execution_claim: false`.
It is a self-reported diagnostic, **not** a signed or independently
verified compiler attestation. A missing ZIP on a zero-runner/zero-step
workflow is expected and must never be treated as evidence of a pass.
A present ZIP is also insufficient: compare the actual GitHub run ID,
attempt, numeric repository and runner IDs, exact commit/tree, required
job/step outcomes, and relevant native test reports using an independent
read-only verifier before making an execution claim.

A synthetic hosted-runner upload control passed at
[ClipTown Actions run 38989763414](https://github.com/cliptown/cliptown-e2e/actions/runs/38989763414)
with artifact `source-free-ci-evidence-38989763414-1`, showing that the
pinned artifact action works on an allocated runner. This was **not**
any of the five source repositories' native compiler CI and did not
transport their private Git trees. Numerical/actor guest parity remains
unverified until backend-native tests execute with reviewed provenance.

The hardened verifier also strictly rejects boolean JSON values masquerading
as integer GitHub job run IDs, final run IDs, or final run-attempt numbers.
Three adversarial regressions reproduced the original acceptance gap and passed
after the fix in the **source-free** private carrier's 63-test execution:
https://github.com/scintilla-run-test/gleam-runner-conformance/actions/runs/38989909170.
This does not authorize private compiler/actor source export and does not
attest native guest-language compilation or execution.

## Independently pinned run attempt (73-case regression gate)

The verifier requires `--run-attempt N` from independently approved release
evidence, and compares it with GitHub's run attempt and every job's attempt.
The existing final reread also checks that the same attempt remains current.
A dynamically chosen latest attempt cannot silently replace reviewed evidence.
The workflow requires at least 73 source-free unittest methods for three rounds.

Example additional CLI argument: `--run-attempt 2` (replace 2 with the
independently recorded value for that run; never infer it from the run being
validated). Passing this verifier attests GitHub execution metadata only,
not private-source export permission, backend-native compiler execution,
or full semantic parity. Source export remains blocked pending protected-main
CODEOWNER enforcement, an approved private destination, and closure of the
private-source exposure incident's resumption gates.

## Rx prototype evidence parity (three additional exact private identities)

The identical verifier also recognizes the three **private** Rx userland prototypes:
`rx_pull` = `ores-truffle-oreslang/rx-ores` (GitHub repository ID 1407870560),
`rx_callbacks` = `ores-truffle-oreslang/rx-ores-callbacks` (ID 1407871059),
and `rx_channels` = `ores-truffle-oreslang/rx-oreslang-channels` (ID 1407757001).
These are pinned *source repository* identities, **not** approved cross-organization
private-code export destinations. A successful source-free workflow validates
GitHub-run provenance only. An Rx guest conformance receipt additionally needs
an independently reviewed matching `compiler.lock` source commit/tree, real
Oreslang compiler execution, negative-parameter and cancellation fixtures,
common downstream benchmark checksum, and output/log evidence. A runner canary,
zero-step run, stale artifact or job on an unrelated repository cannot qualify.

The existing Java destination allowlist remains deny-by-default. Security incident
[platform-conformance #22](https://github.com/ores-truffle-oreslang/oreslang-platform-conformance/issues/22)
and [Java security integration #1123](https://github.com/ores-truffle-oreslang/oreslang-source.java/pull/1123)
are independent authorization/review gates; this extension cannot waive them.

## Final identity revalidation and time-of-check protections

The verifier now performs a **second read** of the source repository's
numeric ID, canonical full name, private visibility, archived and disabled
flags *after* collecting and rechecking the workflow run and job steps.
This prevents a mid-query repository rename, re-creation, publication or
archival from being certified using stale preflight metadata. It also
rejects a boolean masquerading as a numeric workflow ID on the final run
read (Python would otherwise consider `True == 1`).

The shared regression inventory has at least **73 distinct unittest methods**,
including mutation tests that change repository metadata between the initial
and final read and spoof the final workflow ID. Run this entire suite on the
exact checked-out PR tree with no skips before accepting any contract proof.
As always, **source-free evidence is not native compiler/guest parity evidence**,
and no verifier change grants permission to export private source.

## Isolated metadata reporting

The source-free CI report writer runs as `python3 -I -` instead of using
candidate-controlled Python import paths. This prevents local `json.py` or
`pathlib.py` and environment `PYTHONPATH` from shadowing standard-library
imports during metadata reporting. Two new static regressions check both
inline Python heredocs in the checked-in workflow, raising the source-free
contract to **73 tests per round** (three rounds, no skips). This does not
prove guest runtime execution, workflow-file integrity, or source-export
permission; independent protected-main approval and native execution remain required.

## Monotonic runner step execution timestamps

GitHub Actions jobs execute recorded steps sequentially. A successful runner job
must report step timestamps that stay within its job interval and do not
move backward into a preceding step's completion interval. Equal boundaries
are allowed because GitHub returns second-resolution timestamps. The two
additional source-free regressions reject overlapping intervals and accept
adjacent intervals. This is an API evidence consistency check, not an
independent proof of the commands' effects or any guest runtime semantics.

## Strict authenticated GitHub JSON decoding

All identity-bearing GitHub REST responses are now parsed with duplicate-key
rejection at every object depth, strict JSON numeric handling (no NaN,
Infinity, exponential overflow or oversized integer/float tokens), bounded
response bytes, and root-object validation. Previously Python's default
`json.loads` used last-key-wins on duplicate JSON keys and accepted
non-standard floating-point constants. Ambiguous metadata must fail closed,
including when the transport returns HTTP 200.

Five new source-free regression methods cover normal REST object parsing,
duplicate metadata, malformed/nonfinite numbers, invalid encodings and
oversized bodies, plus the actual authenticated fetch-to-parser call path.
Matching Git blobs in Java, LLVM, .NET, WASM and Forge are a **CI evidence
contract parity** property; they do not establish native compiler execution,
guest actor semantics, or authorization to mirror private source.
