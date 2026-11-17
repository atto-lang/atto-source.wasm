# Exact-head evidence gate v1

Call this local composite action **inside the same job** after checkout and the tests being described. It verifies the triggering commit, observed tree, pinned manifest blob, and every listed Git blob. It refuses a dirty working tree.

## Blob manifest

UTF-8 TSV, one entry per line:

```text
<40-character Git blob SHA><TAB>relative/path
```

Blank lines and lines beginning with `#` are ignored. Duplicate paths, traversal paths, absolute paths, an empty manifest, and a changed manifest blob are rejected. The manifest itself is separately pinned by `manifest_sha`.

## Evidence classes

- `host-only`: host runtime tests only.
- `source-only`: source, parser, fixture, or static-contract tests only.
- `guest-executed`: requires a runtime receipt created after actual compiler build and guest execution in the same job.

A guest receipt is UTF-8 key/value text:

```text
schema=oreslang-guest-execution-receipt-v1
source_commit=<exact checked-out commit SHA>
source_tree=<exact checked-out tree SHA>
compiler_source_commit=<40-character compiler source commit SHA>
compiler_source_tree=<40-character compiler source tree SHA>
compiler_sha256=<64-character compiler binary SHA-256>
wasm_sha256=<64-character Wasm artifact SHA-256>
compiler_artifact_path=<absolute path inside GITHUB_WORKSPACE or RUNNER_TEMP>
wasm_artifact_path=<absolute path inside GITHUB_WORKSPACE or RUNNER_TEMP>
executed_cases=<positive integer>
rejected_cases=<nonnegative integer>
```

The receipt must bind the exact source checkout and identify the compiler source and built artifacts. The verifier recomputes SHA-256 from both artifact files, requires them to be non-empty regular files inside `GITHUB_WORKSPACE` or `RUNNER_TEMP`, and rejects symlinked or hard-linked artifact files. It also resolves manifest entries as literal Git tree paths and rejects symlink, submodule, and non-blob entries. This is still **not** a cryptographic build attestation: the reported compiler source commit/tree values and execution counts remain claims made by the same workflow. Keep runner logs and independently verify compiler provenance and test ordering before claiming verified cross-repository parity.

## Example

```yaml
- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
  with:
    ref: ${{ github.event.pull_request.head.sha || github.sha }}
    persist-credentials: false
# Run the required host/source/guest tests before this step.
- uses: ./.github/actions/exact-head-evidence
  with:
    expected_head: ${{ github.event.pull_request.head.sha || github.sha }}
    manifest_path: verification/wasm-pr-blob-manifest.tsv
    manifest_sha: <reviewed manifest Git blob SHA>
    evidence_class: source-only
```

For guest execution, write the receipt after successful compiler and guest steps and pass `evidence_class: guest-executed` plus `guest_receipt_path`. The helper writes `$RUNNER_TEMP/oreslang-exact-head-evidence.json`; upload this from the caller workflow with short retention when needed.
