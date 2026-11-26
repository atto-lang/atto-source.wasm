# Independent tenant guest CI provenance: read-only stage (2026-11-09)

This **stacked draft** builds on Wasm #448. The earlier receipt checker validates self-reported fields.
This new stage independently reads the trusted **source repository's** Git commit, immutable tree
and GitHub Actions run/job/step metadata using GET-only GitHub REST API. It rejects a receipt that
disagrees with a separately pinned repository/head/tree/job identity.

## Locally executed test scope

From the exact stacked files, run:

    node --test tests/tenant-guest-receipt.test.mjs tests/tenant-ci-provenance.test.mjs tests/tenant-broker-case-contract.test.mjs

The 24 Node test functions were executed locally on 2026-11-09 with Node v22.16.0.
Both original #448 file blobs and the four new implementation/test/contract blobs were verified
against their GitHub Git-blob SHAs. **This is not hosted GitHub CI and contains no Atto guest run**.

The new 12 metadata tests exercise swapped source heads, wrong Git tree, misleading success,
unknown run/job IDs, stale attempts, job failure, zero steps, forged/duplicated guest step,
bad or absent execution timestamps, unauthorized carrier claims and read failures.
Two additional checks validate the guest fixture specification, not guest execution.

## Live read-only metadata check

Supply these values from a separately verified source/runner context, **not from the receipt**:
source repository, exact source commit SHA, exact Git tree SHA and expected job ID.
Use GitHub source-owned read authorization with **contents:read** and **actions:read** if
the private repository requires it. Keep credentials local; the command never prints tokens.

    node scripts/verify-tenant-ci-provenance.mjs receipt.json \
      ores-truffle-oreslang/oreslang-source.wasm \
      SOURCE_PR_HEAD_SHA SOURCE_COMMIT_TREE_SHA EXPECTED_JOB_ID

The verifier independently reads:

- GET /repos/{source}/commits/{head} and compares exact SHA and tree.
- GET /repos/{source}/actions/runs/{id} and verifies run ID, browser URL, repository, head,
  run attempt and completed/successful conclusion.
- GET /repos/{source}/actions/runs/{id}/jobs, including bounded pagination, and checks
  exact expected job ID, head, run identity, attempt, completion and a real successful
  step called "execute compiled guest" with start/finish timestamps.

This output is **CI_METADATA_VERIFIED_ONLY**. Even GitHub-reported successful step names are
not proof of executing a source-compiled Atto actor. A malicious workflow can name an empty
shell command "execute compiled guest". This phase does not fetch/validate job logs, independent
artifact bytes, source compiler executable, or guest behavior. To claim real guest execution
requires source/compiler/Wasm or native binary SHA verification and broker observations.

## Carrier hold

**Cross-organization private-source carriers fail closed** in this stage. A receipt's
verified_blob_count, digest strings and zero-mismatch claims are untrusted declarations.
Implement separate independently authorized full-source-tree / path+mode+blob verification
before accepting an approved carrier, and never send a source-org credential to that carrier.
Do not mirror a private tree to a different organization merely because Actions minutes
are available. Independent release/security approval comes first.

## Next required real guest acceptance

The machine-readable fixture contract is at
contracts/tenant-broker-guest-v1/cases.json and explicitly says SPECIFICATION_ONLY_NOT_EXECUTED.
It requires two different authenticated tenant incarnations and five test paths:

1. Quota exhausted in A cannot reset on restart or descendant spawn.
2. Capability revoked after reserve is denied at irreversible dispatch and refunded once.
3. Forged/stale/replayed foreign ActorRef is rejected before destination resolution.
4. Explicitly authorized broker DATA send is delivered exactly once.
5. B continues after A exhausts its quota or is cancelled.

The trusted broker must supply observations, including actual delivery counts,
authenticated producer and destination, lineage, capability generation and quota snapshots.
Synthetic receipts, compiled C-to-Wasm canaries, host allocator tests, and single-tenant
Node worker simulations must not be counted as these five real guest cases.

## CI hold and release policy

As of this audit, source Actions for #448 (including runs 42657762711 and 42657762401)
were reported as failed with zero job steps: **NOT_EXECUTED / runner admission**.
No currently inspected result establishes five-backend tenant broker enforcement.
Keep PRs DRAFT and default UNTRUSTED cross-tenant/network grants denied; independently
review guest ABI/lowering, trust boundary, lifetime accounting and physical isolation
before making production claims. This gate does not trigger CI or rerun jobs.
