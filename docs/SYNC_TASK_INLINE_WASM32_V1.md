# Source-compiled inline sync task wasm32 gate v1

**Status:** real-compiler integration gate authored; no current-head guest execution recorded in this PR. Only the restricted inline profile from atto-source.rs draft #438 is in scope.

The canonical fixture `tests/fixtures/sync-task-inline-v1/main.atto` has Git blob SHA-1 `e08cbf7ccc5b0d041897ce215c2c3a1f434f983f` and demonstrates: `do sync task {}`; `do sync task<void> {}`; and `val result = sync task<int> { return 40 + 2; }`. Discarded inline tasks **may only return void** and require `do`. A bare standalone `sync task` statement, a `do sync task<int>` or a non-void return in a discarded block must fail with no emitted Wasm.

This backend does not implement its own source compiler. An independently reviewed and SHA-256-pinned native Rust `attoc` from the exact #438 dependency stack must compile this unchanged fixture and the additional positive/negative cases into actual Wasm. The verifier performs strict bounded private-memory, zero-host-import and entry/export validation and executes the guest in Node. Negative cases assert compiler-owned diagnostics and **no generated artifact**, not a JavaScript source parser.

## Commands

Node host-only admission tests (included in npm test):

    node --check scripts/verify-sync-task-wasm.mjs
    node --test tests/sync-task-verifier-admission.test.mjs

Required real guest gate (fail-closed without exact reviewed compiler):

    node scripts/verify-sync-task-wasm.mjs /absolute/reviewed/attoc <compiler_sha256_64hex>

The gate checks two source-compiled positive guests (42), seven compiler negatives and binary pin stability. A passing source-only test does NOT establish these guest outcomes.

## Security, dependencies and nonclaims

- atto-source.rs #438 already implements native Rust/wasm32 inline Task IR lowering and owns the compiler. This PR does **not** fork that implementation.
- atto-platform-conformance #115 owns the broader task/cancel/lock fixture registry and source-only admission matrix; atto-spec #129 owns the language rules.
- These positive inline tasks execute on the caller's logical path; this gate alone does not establish physical TaskId lifetime/fuel/cancel behavior.
- General `task<T>`, `await task`, child TaskScope, recursive cancellation, resource-guard unwind, TenantVM isolation and actor-owned resumption are **NOT IMPLEMENTED/NOT EXECUTED** here. They remain fail-closed in this restricted compiler profile.
- Exact source head/tree, compiler binary provenance, nonzero stepful CI, actual guest execution, independent review and applicable security checks are still required. Do not use any unapproved private cross-org Git-tree copy.

**Merge hold:** draft, unmerged until all relevant gates pass. A Rust #438 run is not transferable to this PR's exact Wasm source head.
