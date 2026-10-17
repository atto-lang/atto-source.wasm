# Source-free exact-run verifier receipt — 77 tests (NOT compiler parity)

**Classification:** `SOURCE_FREE_CI_SECURITY_REGRESSIONS_ONLY`. This file is evidence
about the shared `verify_ci_run.py` verifier and its regression tests, **not** evidence
that the private Oreslang compiler, actor runtime, or a `.ores` guest executed.

## Independently inspected GitHub-hosted evidence

- Private runner repository: `scintilla-run-test/gleam-runner-conformance`.
- Successful [workflow run 38996750516](https://github.com/scintilla-run-test/gleam-runner-conformance/actions/runs/38996750516), attempt `1`, event `push`, workflow `.github/workflows/oreslang-sourcefree-77-parity-20261016.yml`.
- Carrier Git HEAD: `cb37064568d13cd2b051940d01f148a5a13d1b07`; tree: `b73b0af44ef5c1ba60d5186901f213bfaa7bd5ad`.
- Runner-executed job: `source-free-77`, job `117290889613`, **8 job steps**, successful.
- Test result: **77/77 per round × 3 rounds = 231/231**, no failures or skips. The job log contains separate completion lines for all three rounds.
- [Artifact 12087306517](https://github.com/scintilla-run-test/gleam-runner-conformance/actions/runs/38996750516/artifacts/12087306517), `oreslang-sourcefree-77-38996750516-1`; ZIP SHA-256 `f6f2f42fbb614ca5f7b9b5defa5e6eace150ffeeb29be268059b9a93efcea901`, matches the downloaded ZIP.
- Artifact JSON `77-parity.json`: `source_free_only=true`, `guest_runtime_certified=false`, `source_repository_native_ci_certified=false`, `private_runtime_or_compiler_source_transferred=false`.
- Git blob for `scripts/verify_ci_run.py`: `de7b3921a66c32f50115ee9933ef4e391ec34f8f`.
- Git blob for `scripts/test_verify_ci_run.py`: `b73b3c06da3170294b5dfb589ba2131af217d268`.
- These two blob identities were independently checked against the five Java, LLVM, .NET, Forge, and Wasm verifier review branches, matching the executed carrier HEAD byte-for-byte.
- GitHub reports artifact expiration `2026-10-24T02:54:52Z`. Save the digest-pinned receipt under approved retention controls if longer audit retention is needed.

## What this does NOT certify

No private compiler or runtime tree was transferred in this run. Source-free verifier
execution proves neither source-org Actions runner admission nor Java/GraalVM, native
LLVM, .NET Native AOT, Forge or Wasm guest execution. It cannot be entered as an
`executed-claimed` native record in the shared five-backend execution ledger.
Do **not** change any `pending`/ `unsupported` native parity status or merge
implementation drafts solely on this receipt.

Source CI still needs a genuine allocated runner, exact source commit/tree, reviewed
workflow blob, actual compiler build, native/guest fixture outcomes, sanitized logs
and downloaded artifact hashes. Cross-organization private-source mirroring remains
**blocked** pending containment of [incident #22](https://github.com/ores-truffle-oreslang/oreslang-platform-conformance/issues/22),
independently reviewed source-main protection, and exact private destination repository
ID approval. Available Actions minutes alone are not source-transfer authorization.
