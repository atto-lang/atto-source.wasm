# Rust structural parity inventory audit

This Rust CLI replaces the legacy Python inventory checker used by
.github/workflows/structural-parity-audit.yml. It is a source-inventory
integrity gate only. It never grants native compiler, wasm32 guest execution,
AOT, or five-backend feature parity.

The verifier checks the exact 14 ordered case IDs and proof stages, all five
backend capability declarations, the unverified runtime evidence fields, the
unchanged disclaimer, and the pinned Git blob hash of
contracts/v1/STRUCTURAL_MATCH_V1.md. Parsing rejects duplicate JSON object keys
at any depth and fails on malformed or oversized inputs.

Run from the repository checkout:

    cargo test --manifest-path tools/structural-parity-audit/Cargo.toml --all-targets
    cargo run --manifest-path tools/structural-parity-audit/Cargo.toml -- --self-test
    cargo run --manifest-path tools/structural-parity-audit/Cargo.toml -- --check

The --require-parity mode MUST exit unsuccessfully even when --check succeeds.
This is deliberate: guest execution requires independent exact-head compiler
and runtime evidence, not an inventory-only audit.

A successful CI run must contain executed test steps. Workflow queue failures,
runner_id=0, empty steps, or an absent Rust compiler are NOT_EXECUTED, not
passing Rust tests. Keep this PR in draft until an authorized source-local
runner executes the Rust tests on the exact PR head and review is complete.
