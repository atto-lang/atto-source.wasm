# Oreslang scalar50 v1 — five-backend execution contract

**Canonical input**: `v1.tsv`, 50 line-oriented, single-line `.ores` programs and their exact signed-i64 expected results.
Git blob SHA-1 (including the Git `blob SIZE\\0` header): `a948dbaf594916a6ee07f65d49a0cf5ae398ca7b`.

The test corpus is intentionally a *small shared scalar floor*, not a claim of full language parity. The 50 cases vary arithmetic precedence, parentheses, associativity, and unary negation. Native process-return values are all positive and below 128 so POSIX exit status is unambiguous.

## Required backend tests

| Backend | Runner | Evidence actually established by an executed passing run |
| --- | --- | --- |
| Java / GraalVM | `SharedScalarFiftySourceTest` | Java OresCompiler parsed and typechecked 50 exact sources; **not** native guest execution |
| LLVM | `native_shared_scalar50_compiler_and_guest_execution` CTest | 50 sources compiled to LLVM IR, linked with Clang and executed as native processes |
| WASM | `tests/shared-scalar50.test.mjs` | Git-pinned corpus; with an independently attested real compiler, 50 guest exports actually executed (Node WebAssembly); **not** a Wasmtime-isolate attestation |
| Cranelift | `tests/shared_scalar50.rs` | 50 source programs compiled by the real Cranelift JIT and evaluated |
| .NET | `SharedScalarFiftyParityTests.Run()` | 50 typed OresIR and emitted CIL results independently evaluated; **not** a Native AOT guest receipt |

## Verification, evidence and limits

* Require exact PR HEAD commit, root Git tree and this corpus blob **before** checking outcomes. Re-check the branch ref after the workflow and never substitute a different commit.
* A GitHub Actions workflow with `steps=[]` or missing executed jobs is **runner admission failure**, not passing or failing compilation.
* Treat source-free verification, host reference evaluation, compiler admission, compiler-generated code and actual guest execution as different phases. Never aggregate them into one unconditional success.
* A real guest receipt should include backend/toolchain version, executable SHA-256 and independently verified compiler provenance, host ABI/architecture, immutable source hash, executed job/step IDs and each case's exit/result; also ensure negative tests fail for the intended diagnostic.
* No private compiler/source tree may be copied across organizations merely because an alternate organization has available Actions minutes. Source and destination policy approvals, exact-tree identity and independent review remain prerequisites.

All 50 entries are **positive scalar cases**. Ownership, actor, Option/Result, trap, async, channel and security/rejection parity require separate toolchain-specific native conformance gates and must not be inferred from these tests.
