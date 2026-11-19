# PR #108 — staged Rust-only tooling reconciliation

Historical head `cc0e4f3da80efbbe869a69ca586f03554999c406`; modern Wasm main `072648b8c9840541e0b7a741c5ac6c5e643cece0`.

The old 36-file migration replaces legacy numeric, arena, reactive, contract and model checks, plus Actions. Blindly replaying those files would overwrite current actor-memory, continuation, WIT and CI security contracts; deleting Python scripts without independently equivalent Rust tests would weaken coverage. Current main still contains Python artifacts, so enabling a mandatory global no-Python scan before migration would break CI.

Stage only the historical dependency-free `tools/no-python-check` Rust crate and its five unit tests as an **opt-in policy validator**. Do **not** enable it as required CI yet. This scanner rejects forbidden artifacts, Python CI/shell invocations and Python shebangs, while allowing relevant explanatory prose. It will intentionally report current unmigrated files if invoked on the full repo.

Before enforcing policy: replace scalar vectors; enum nullary/overlap/slot ABI tests; actor arena lifecycle, quiescence and shared-domain receipts; reactive-signal contract; AOT negative fixtures; CI attestation; and formal/source checker tests. Each replacement must preserve positive/negative evidence, run under exact-head source CI, and be independently reviewed. Only then retire the corresponding Python artifacts and enable the scan in a separate PR.

`cargo test --manifest-path tools/no-python-check/Cargo.toml` and Cargo clippy/fmt are the initial *checker-specific* acceptance gates. No native Wasm or compiler guest execution has been established by this merge-tree reconciliation.
