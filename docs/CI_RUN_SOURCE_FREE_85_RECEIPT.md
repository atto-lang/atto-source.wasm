# Source-free verifier receipt — 85 cases × 3 rounds (not compiler parity)

**Evidence class: SOURCE-FREE CI SECURITY / GITHUB RUN PROVENANCE ONLY.**
No private compiler or actor source was exported. Do not interpret this
receipt as native or guest execution, even though the hosted CI job passed.

## Independently verified current receipt

- Private source-free carrier: `scintilla-run-test/gleam-runner-conformance`.
- Successful [run #38998088804](https://github.com/scintilla-run-test/gleam-runner-conformance/actions/runs/38998088804), attempt 1, 8 executed job steps, job `source-free-85` (#117294970323).
- Carrier HEAD `ba78a09a767a43acf9f248d1999fa41456c1c5a4`; tree `eca4be6b8e286955733bdc31d8d8570535632ba1`.
- Workflow `.github/workflows/oreslang-sourcefree-85-union-20261016.yml`.
- Tests: **85/85 in each of three complete rounds = 255/255**.
- Shared verifier blob: `b59a7880f060582694ed4a9862caede5e5f3e8b9`.
- Shared regression suite blob: `84eedb6beec2e8fbe81b7539095ef4550a09b0cf`.
- Source-free reference workflow blob: `78bd3f8e95f2097d244468d80833f696fed46141`.
- [GitHub artifact #12087253307](https://github.com/scintilla-run-test/gleam-runner-conformance/actions/runs/38998088804/artifacts/12087253307), ZIP SHA-256 `cf6076b613f70b9098915ef4724bcc0f18c3f31c6c06dfb0b4749f8d22da67c0`. The downloaded artifact was hashed independently and `85-parity.json` inspected.
- Report `schema:oreslang.source_free_ci_verifier_85.v1`, `tests_per_round:85`, `rounds:3`, `expected_total:255`. These values are arithmetically consistent.
- The artifact explicitly states `source_free_only:true`, `guest_runtime_certified:false`, `source_repository_native_ci_certified:false`, and `private_runtime_or_compiler_source_transferred:false`.

The verifier and regression test Git blobs match the Java, LLVM, .NET,
Forge and WASM `ci/exact-gh-run-evidence-v1-20261016` review branches.
This confirms **source-free verifier/test byte parity**, not compiler parity.

## Invalid earlier artifact and corrected historical run

The earlier 82-case carrier run #38997306268 wrote `expected_total:231`
despite `tests_per_round:82` and `rounds:3`. Reject that artifact.
The repaired 82-case run [#38997728835](https://github.com/scintilla-run-test/gleam-runner-conformance/actions/runs/38997728835)
correctly emitted **246/246** with artifact ZIP digest
`377f9566dc24c4e014723032d7cba3579b0ec6bc55329711ada87c42e3bed80d`.
The new 85-case receipt above is a distinct, later source-free result.

## Release boundary

Neither source-free artifacts nor alternative organization runner minutes
authorize private source transfer. Actual backend execution requires
immutable source HEAD/tree, approved protected-main source-export policy,
allocated native runner, compiler/guest fixtures, test logs and independently
hashed output artifacts. All five native compiler records remain pending.
The public-source exposure [incident #22](https://github.com/ores-truffle-oreslang/oreslang-platform-conformance/issues/22)
and private-CI policy review must be resolved first.
