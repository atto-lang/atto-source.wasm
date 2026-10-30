# Shared reactor / SoA validation — 2026-10-29

PASS locally: Node 24.22.1, 11 tests across shared-reactor-policy, nio-actor-admission and async-io-zero-capability. Unsupported workers fail before guest decoding.

Host components remain opt-in. Existing runtime/CLI defaults and guest feature admission are not switched to these pools. No compiler-backed five-backend guest parity or hard-real-time guarantee is claimed. The native and Java tests cover bounded saturation, 8,000 concurrent submissions, one polling owner, actual readiness, same-thread polling/execution in one-worker mode, hot-ready-queue I/O fairness, explicit growth, ordinary task failure, self-join rejection and accepted-work draining.

.NET uses the same scenario set but still needs actual SDK10 execution. WASM has admission parity only. Production actor/CONTROL/isolate integration, cancellation/kernel retirement, flags-2-env CLI integration, full backend regression and hardware performance gates remain outstanding.

## Exact component Git blobs

- `src/shared-reactor-policy.mjs`: `c2990231eed2240d1649d25d8bfde970af9c7f0c`
- `tests/shared-reactor-policy.test.mjs`: `c988d5cb09737c951d00396cb297ae9ec7cc5c1c`

- `src/isolated-runner.mjs`: `b00f4f773d50bd06350b0dab8e7d2c5babf5537c`

The public isolated runner also rejects shared-worker options before spawning a guest worker. Its default scalar fixture executed 42 and terminated normally.
