# Core logging / OTel boundary — Wasm / no-import host

**Audit date:** 2026-10-16. **Status:** documented target only; implementation parity **not established**.

Shared design: [core logging and userland OTel contract](https://github.com/ores-truffle-oreslang/oreslang-common-source/blob/audit/core-logging-separation-2026-10-16/docs/CORE_LOGGING_AND_OTEL.md).

## Verified repository status

The admitted WebAssembly guest ABI is currently `() -> i64` with zero guest imports. Actor I/O, host I/O, stdout and standard library package imports are not supported.

## Required backend behavior

- Core/internal standard-library diagnostics are controlled by host CLI/configuration, disabled by default, and independent of explicit userland `oreslang-otel` imports.
- Future canonical core flags: `--core-log-level=off|error|warn|info|debug|trace` and `--no-core-log`. These are **not currently declared implemented for this backend**; do not advertise them as usable.
- Never perform guest message formatting, string interpolation, allocating event construction, filesystem/network export, or telemetry callbacks in a scheduler/actor/borrow checker critical path. Disabled paths must not sample the clock or evaluate an expensive payload.
- Keep guest stdout and functional errors unaffected by diagnostic settings. No guest payload, headers, credentials or arbitrary dynamic fields in core events.
- Version schemas; record numeric IDs and timestamps in bounded primitive buffers; export to host stderr only off the hot path.

## Implementation and test gates

Preserve zero-import capability isolation: Oreslang guest source requesting logging or `oreslang-otel` must fail compilation/admission, not silently acquire a console or host callback. Host-side runner diagnostics may be controlled by validated CLI flags and must use stderr and bounded fixed-ID data without exposing guest buffers. If adding guest logging, first design and separately version a capability-bearing host ABI and prove no-import stays default. Test invalid flags and attempted imports, worker deadline and stdout isolation.

Do not mark parity green until a compiled/linked artifact has passed negative admission tests, CLI configuration-precedence tests, saturation and concurrent publication tests, and disabled/enabled performance tests. Record the exact source tree and CI run.
