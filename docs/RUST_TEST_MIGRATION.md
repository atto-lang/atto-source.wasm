# Wasm testing migration: Python → Rust

This is an **inventory and work plan**, not a claim that existing Python
tests are migrated. Follow [AGENTS.md](../AGENTS.md) and the canonical
[organization policy](https://github.com/ores-truffle-oreslang/.github/blob/main/docs/RUST_ONLY_POLICY.md).

## Completed in this draft

- `.github/workflows/runner-admission-canary.yml`: replace the old Python
  inline sanity check with three checkout-free, token-free `rustc --test`
  cases. Check actual runner identity, run/attempt/commit binding, and the
  canary signature. Keep GitHub's independently observed `runner_id > 0`
  and nonempty step list as the execution evidence requirement.
- `.github/workflows/rust-tooling-regression.yml`: provide an **additional**
  exact-head Rust-only `cargo test` workflow for the no-Python checker,
  repository-policy utilities, serde contract gate, and rollout evidence
  validator. This does **not** replace full guest runtime CI.
- `tools/no-python-check/src/main.rs`: add regression cases for versioned
  interpreters and pip/uv variants without introducing Python tooling.

## Legacy migration backlog — not yet complete

| Existing surface | Replacement and proof requirement |
| --- | --- |
| `.github/workflows/ci.yml`, `contracts/v1/verify_actor_pipeline_v1.py` and `test_actor_pipeline_v1.py` | Rust JSON graph validator + mutation/fault cases. Retain duplicate-key, nonfinite, filesystem race, graph cycle, role, FNV64 and byte-budget rejection. |
| `.github/workflows/ci.yml`, `tests/test_numeric_*.py` | Rust exact checked-i64 / binary64 reference corpus. Maintain all overflow and precision test vectors and never confuse reference checks with compiled guest execution. |
| `contracts/scalar/v1/run.py` and `selftest.py` | Rust bounded parser/process and copy-on-verify fixture runner. Preserve strict identity, negative cases, SHA-256 pin, timeout and temp-file cleanup. |
| `tests/check_atto_core_snapshot.py`, `test_atto_core_snapshot.py` | Rust Git-blob SHA-1 snapshot verifier with symlink, hardlink, BOM/NUL, UTF-8, size and wrong-file tests. |
| `scripts/check-structural-parity.py` and `check-structural-v2.py` | Rust strict JSON and pinned-blob verification, positive/negative mutation tests. Keep `unverified` capability flags intact. |
| `.github/workflows/private-ci-policy.yml` embedded Python | Separately reviewed Rust fail-closed governance checker, preserving all protected policy/owner validation and anti-export rules before workflow substitution. |
| Other `contracts/**/*.py` and `scripts/**/*.py` | Inventory their callers and fixtures and migrate in bounded PRs with exact baseline-vs-Rust behavior tests. |

## Admission and retirement gates

1. A migration PR contains working Rust implementation, positive and negative
   Rust tests, and the exact prior Python behavior/specification it preserves.
2. Only after the Rust checker executes and is independently reviewed do we
   remove the Python implementation and switch all its CI callers.
3. Preserve JS/Node Worker and browser tests that exercise actual host behavior,
   alongside separately proven compiler-backed `.atto` and wasm32 artifacts.
4. Require exact-head, **nonzero-step** authorized CI. Zero-step source Actions
   failures mean `NOT_EXECUTED`, even if local host tests pass.
5. Do not mirror the private Git tree to a foreign CI organization without
   approved destination, source-authorized snapshot, and independent review.

The migration order should start with isolated, source-free checks, followed
by contract verifiers, then the security-critical policy/runner gates.
