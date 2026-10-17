# Source-free CI verifier receipt — 77 × 3 (non-native)

This document deliberately provides **source-free test provenance only**, not an Oreslang compiler, native ABI, actor-runtime, or `.ores` guest-execution certificate. All five backend-native records remain pending.

- Private carrier: `scintilla-run-test/gleam-runner-conformance` (GitHub repo ID `1323598260`).
- Completed [run 38996750516](https://github.com/scintilla-run-test/gleam-runner-conformance/actions/runs/38996750516), attempt 1; actual job `source-free-77` ID `117290889613` executed verifier regression tests and uploaded an artifact.
- Source-free regression count: **77 cases × 3 rounds = 231 successful executions**; native compiler and guest test counts: **0 verified**.
- Carrier head: `cb37064568d13cd2b051940d01f148a5a13d1b07`; carrier tree: `b73b0af44ef5c1ba60d5186901f213bfaa7bd5ad`.
- Artifact ID: `12087306517`, archive `oreslang-sourcefree-77-38996750516-1`; downloaded ZIP SHA-256 `f6f2f42fbb614ca5f7b9b5defa5e6eace150ffeeb29be268059b9a93efcea901`. Inner report: `77-parity.json`.
- Pinned verifier: `scripts/verify_ci_run.py` at Git blob `de7b3921a66c32f50115ee9933ef4e391ec34f8f`.
- Pinned tests: `scripts/test_verify_ci_run.py` at Git blob `b73b3c06da3170294b5dfb589ba2131af217d268`.
- Pinned workflow: `.github/workflows/ci-run-evidence-contract.yml` at Git blob `36e375543b44b6c2cab3a1705f4a08a2dd40c9eb`.
- All **three blobs were independently fetched and identical** at each of the five source-verifier PR heads on 2026-10-17 UTC: Java #1112, LLVM #495, .NET #56, WASM #52, Forge #50. This is file parity, **not whole-repository parity**.

The canonical machine-readable receipt lives in [platform conformance draft PR #58](https://github.com/ores-truffle-oreslang/oreslang-platform-conformance/pull/58) at `evidence/source-free-ci-77-38996750516.json`. Its companion regression denies promotion into the five-backend native evidence ledger.

## Blocked release/security gates

1. [P0 exposed public source carrier #22](https://github.com/ores-truffle-oreslang/oreslang-platform-conformance/issues/22): the separately identified public repository `zed-pkg-test/java-app` still requires administrator containment and incident response.
2. [Source protection #904](https://github.com/ores-truffle-oreslang/oreslang-source.java/issues/904), [publisher #954](https://github.com/ores-truffle-oreslang/oreslang-source.java/pull/954) and [source-export admission #962](https://github.com/ores-truffle-oreslang/oreslang-source.java/issues/962): no protected-main approval to copy private source across GitHub orgs.
3. Recent source-org Actions runs have failed with **zero executed steps, no native artifacts**. Their upstream billing/runner/policy cause is not independently established.
4. Do not merge, certify native parity, publish private source, or treat an alternate-org source-free canary as authorization. Use approved private source-local CI until protective controls, runner capacity and independent reviews are established.
