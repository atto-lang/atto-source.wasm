# Rust-authored multi-file source -> wasm32 package guest gate

**Status:** authored integration and host admission tests. Real compiler-backed guest execution on this PR is NOT_EXECUTED until an independently approved attoc binary runs with the exact source commit.

## Scope

The standard Wasm `scripts/compile-ores.mjs` path continues to reject source imports: it is the separate LLVM-based `core-wasm.i64-v1` scalar compiler bridge and does not own the full package graph. No import rejection is removed or relaxed.

This opt-in integration tests the *existing* Rust-authored `atto-source.rs` package compiler (`attoc --package-root ROOT --entry src/main.atto -o guest.wasm`), not a second JS parser or linker. In Rust's current implementation, the `package_resolver` and `linker` already accept a bounded three-file `main -> Orders -> Math` graph with manifest-rooted `+lib/orders.atto` and a relative `./math.atto` dependency. These are admitted profile spellings; the canonical new import grammar in atto-spec must be aligned separately.

Source paths and Git blob SHA-1 pins in `tests/fixtures/linked-package-v1`: 

- `.atto.pkg.toml`: `4177f0f46272526a45fb9db775efa71814f4657b`
- `src/main.atto`: `22d252e703502488407c948f0f3f84cc1d91d36a`
- `lib/orders.atto`: `868403fab2f8d3524bf0cf54799bca6d80e89b43`
- `lib/math.atto`: `525585c4eb34a4572b7041cf72d658c66fd045cc`

## Commands and evidence classes

Source/host admission suite, automatically included in npm test:

    node --check scripts/verify-linked-package-wasm.mjs
    node --test tests/linked-package-verifier-admission.test.mjs

Required actual compiler + guest gate:

    node scripts/verify-linked-package-wasm.mjs /absolute/reviewed/attoc <exact-compiler-sha256>

The mandatory gate builds and executes a real import-free wasm32 guest returning signed `42` from three linked source files. It also requires no output artifact on private member access, missing transitive dependency, path traversal, import cycle and symlink escape. The binary size, optional private linear memory (absent for scalar-only guests, fixed and bounded if present), imports, typed export ABI, source blob identities, toolchain digest and child-process outcome are bounded. Memoryless scalar guests must not be rejected merely because they lack a memory section; unbounded or hidden present memory is denied. Compiler SHA alone is NOT proof of reviewed source-to-binary provenance.

This is a trusted test fixture and not a production untrusted-TenantVM sandbox. It does not grant Wasm imports, guest filesystem or sockets; the package source filesystem access occurs in the trusted compiler process, not guest execution.

## Outstanding release gates

- Independently authenticate attoc source head/tree and exact executable SHA. Rebuild from a reviewed, clean source tree with successful nonzero CI steps.
- Execute the full positive/negative gate, record Wasm guest SHA, actual stdout/value and compiler diagnostics at exact current head.
- Extend source grammar to canonical unified static import syntax where needed; preserve explicit compatibility profiles.
- Cross-backend Java/LLVM/AOT parity, package locking, nested package symlink and tenant isolation require separate executable evidence.
- On any missing/failed/skipped/zero-step run, status stays NOT_EXECUTED or FAILED, never PASSED.

Overlap: Rust `src/linker.rs`, `src/package_resolver.rs`, `tests/multihop_linker.rs`, and `examples/linked_guest.rs` already own language/graph compiler semantics. This PR integrates those capabilities into Wasm's explicit evidence gate; it does not replicate the linker or conflict with Wasm migration #49.
