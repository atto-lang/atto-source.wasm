# Proposed private CI destination — independent review required

Status: **DRAFT / NOT AUTHORIZED FOR SOURCE TRANSFER** (2026-11-20).

## Candidate identity and source-free capacity
- Exact repository: `memebank/atto-ci`
- GitHub numeric repository ID: `1458315477`
- Visibility: **private** (verified via GitHub repository metadata)
- Observed successful run: [44809549691](https://github.com/memebank/atto-ci/actions/runs/44809549691)
- Observed job: `136542266106`, with **11 completed successful steps**, including real checkout, blob inventory checking, Rust build, and a compiled Wasm guest test.
- This is *capacity evidence only*. The run concerned a separate scoped Rust snapshot. It does **not** prove that this WASM repository's source was copied, approved, built, or tested.

## Source authority: currently denied
The effective policy on `atto-lang/atto-source.wasm` `main` currently has:
- `.github/private-ci-independent-reviewer.json`: `enabled: false`, `reviewer: null`.
- `.github/private-ci-approved-repositories.txt`: no active destination entries.
- `.github/private-ci-approved-source-snapshots.txt`: no active source snapshot entries.
- GitHub `main` branch metadata: `protected: false`.
- The `main` branch remains authoritative, not this PR's proposed allowlist.

**This PR does not add any destination to the approval allowlist.** The proposed destination is recorded in this document only. The live and branch-local `.github/private-ci-approved-repositories.txt` and `.github/private-ci-approved-source-snapshots.txt` both remain deny-all; `.github/private-ci-independent-reviewer.json` stays disabled. The repository's policy explicitly rejects active destination entries while the reviewer is disabled. Do not mirror any private source or use same-person administrative approval as independent security review.

## Mandatory independent admission sequence
1. Establish mandatory protected-`main` CODEOWNERS and CI, with no bypass; independently verify enforcement through GitHub settings/ruleset reads.
2. Review the exact destination visibility, name, **numeric repository ID**, workflow permissions and trust boundary. Obtain an eligible independent reviewer who is not in the disallowed reviewer ID list.
3. Independently review and merge the secure publisher/approval policy first, with the external-carrier permission still inactive until all policy checks pass.
4. Create a **separate, explicit** immutable source-snapshot approval for a *single* current PR head: `source_commit_40hex source_root_tree_40hex destination_repository_id`; never authorize an org, wildcard or floating branch.
5. Preflight source and destination repository IDs, pinned source commit/root tree and every blob SHA/mode/path. Mirror by writing **new exact blobs/trees** to a temporary private carrier branch using GitHub connector Git data APIs, without user PATs or cross-org checkout token. Verify carrier tree matches the approved source tree before and after.
6. Run stepful Node 22 `npm test`, exact-head host and compiled guest checks with real native compiler provenance. Reconcile negative tests and fail on skipped/missing/zero-step evidence; capture original source commit + root tree + test result + mirror tree receipt.
7. Revoke/delete the temporary carrier branch and corresponding approval once evidence has been captured and independently reviewed.

This proposal does not grant the source mirror, make any draft mergeable for release, or assert cross-backend parity.
