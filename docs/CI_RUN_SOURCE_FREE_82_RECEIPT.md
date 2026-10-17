# Source-free exact-run verifier receipt — 82 cases × 3 rounds (NOT native parity)

This file is an audit receipt for shared GitHub Actions provenance-verifier tests.
It is **not** evidence that any Oreslang compiler, actor runtime, or `.ores` guest
executed, and it grants **no** permission to transfer private source across orgs.

## Validated hosted execution

- Private source-free carrier: `scintilla-run-test/gleam-runner-conformance`.
- Successful [run 38997728835](https://github.com/scintilla-run-test/gleam-runner-conformance/actions/runs/38997728835), attempt 1, `push` event; job `source-free-82` (#117293864666), 8 completed successful GitHub job steps.
- Carrier HEAD: `36204819e5439de6964b8d3b297ba4c75420b9d2`; tree: `07f7164cd1f802ee6c46b0102649819592504d29`.
- Workflow: `.github/workflows/oreslang-sourcefree-82-strict-json-20261016.yml`.
- Executed regression test counts: **82 + 82 + 82 = 246**, all passed without skipped or failed cases.
- Exact source-free verifier Git blob: `1d7b03db64a8576b5c4271b6f7571df503dffd81`.
- Exact source-free test Git blob: `45ada59ac6001254897edf9f8cd3b75ef4f58acc`.
- Source-free reference workflow blob: `c62d13b3c3e9d666d90f752bcf96cbe07588a648`.
- [Artifact #12087892537](https://github.com/scintilla-run-test/gleam-runner-conformance/actions/runs/38997728835/artifacts/12087892537), ZIP SHA-256: `377f9566dc24c4e014723032d7cba3579b0ec6bc55329711ada87c42e3bed80d`. The downloaded ZIP's SHA-256 matched GitHub and the included `82-parity.json` was inspected.
- `82-parity.json` reports `schema:oreslang.source_free_ci_verifier_82.v1`, `tests_per_round:82`, `rounds:3`, `expected_total:246`, `source_free_only:true`, `guest_runtime_certified:false`, `source_repository_native_ci_certified:false`, `private_runtime_or_compiler_source_transferred:false`.

Both source-free Git blobs were checked byte-identical across the Java, LLVM,
.NET, Forge and WASM verifier PR branches, and match the carrier's exact HEAD.
**This confirms source-free verifier/test parity only.** It does not verify
source-organization runner allocation, native compilation, guest results,
private source confidentiality, or runtime parity.

## Invalid earlier 82-case receipt

[Run 38997306268](https://github.com/scintilla-run-test/gleam-runner-conformance/actions/runs/38997306268)
reported 82 tests per round for 3 rounds but its artifact JSON incorrectly
recorded `expected_total:231`. This arithmetic inconsistency is real, and that
artifact must **not** be used as a validated 246-test receipt. The source-free
workflow was corrected in [commit 3620481](https://github.com/scintilla-run-test/gleam-runner-conformance/commit/36204819e5439de6964b8d3b297ba4c75420b9d2):
it persists executed round counts, derives their sum, checks `[82,82,82]` and
`246`, verifies the report total matches rounds × tests per round, and reads
the serialized report back before upload. The new run succeeded.

## Release/security boundary

Keep compiler/runtime records `pending` until actual native guest execution
on immutable, reviewed exact source HEADs has passed with authenticated
workflow, job/step, log, and artifact-byte evidence. GitHub zero-step failures
are **not** compiler execution. Do not export private source based on alternate
GitHub Actions runner capacity. [P0 source exposure incident #22](https://github.com/ores-truffle-oreslang/oreslang-platform-conformance/issues/22),
protected-main security policy and independently reviewed private destination
repository ID approval must be resolved first.
