# Platform core signed-i64 parity candidates v1

All five source repositories (Java/Graal, LLVM, Wasm, Cranelift and .NET) receive the **same** UTF-8 source fixture bytes and manifest. The seven positive programs exercise bounded signed-i64 arithmetic and strict operator precedence. Five negative programs cover unresolved identifiers, implicit string-to-int conversion, arithmetic overflow, legacy XOR operator, and missing required return. Their expected results are **candidate specifications**, not proof that any given backend currently implements or rejects them. Review each backend's actual language profile before adding promotion gates.

`native-testing-core.ores` registers **seven native Oreslang cases**, importing the canonical `ores.std/testing` test harness. This file is **not** compiled by a real guest launcher in this changeset. Cranelift stage-0 does not support Oreslang imports/stdlib, and no Cranelift TestSuite parity is claimed.

Cranelift uniquely adds `tests/platform_core_v1.rs`, an executable **Rust integration test** that invokes its actual native CLI/JIT on the 7 positive fixtures and 5 negatives (each case has an individual test). It also asserts that the native stdlib suite is rejected rather than incorrectly credited as supported.

## Evidence requirements

1. Pin exact source checkout commit and complete tree; independently verify fixture Git blob identity across the five repositories (and stdlib/testing.ores identity when used).
2. Compile and execute each positive with an actual compiler/runtime, require exact expected stdout and exit 0; require nonzero for each negative and inspect diagnostic type. Distinguish compile diagnostics from runtime overflow/exit faults.
3. Native `ORES_TEST` suite requires exactly 7 unique PASS events, one summary with `total=7|passed=7|failed=0|skipped=0|filtered=0`, actual guest exit 0, no fake runner or host emulation.
4. Verify GitHub run ID, attempt, job ID, exact SHA, **nonzero executed steps**, compiler artifact SHA-256, and immutable fixture digests. Independent approval and protected main are mandatory for merge/promotion.

Never count a zero-step Actions run, fixture readback, Rust host-only tests, or signed JSON without authenticated provenance as successful compiler parity. No unapproved private-source transfer between organizations.

Known independent language gap requiring a separate migration: Cranelift main currently accepts the legacy `%` operator while the new language rule reserves named `Integer.rem`/`Integer.mod`; do not silently report operator-surface parity. Existing Cranelift PR #31 adds named semantics but does not automatically reconcile old operator tests.
