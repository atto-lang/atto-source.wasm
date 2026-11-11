# AttoLang borrow checker — six-backend conformance V1

**Evidence: source-authored contract; NOT executed compiler parity.**

This contract fixes one common baseline for `oreslang-source.java`, `.llvm`, `.net`, `.wasm`, `.forge` and `.cranelift`. It is a *restricted, acyclic typed ownership-event CFG* vocabulary compatible with the **intent** of the Rust canonical V0 design. It is not an alternative full borrow checker. Its JavaScript tests exercise an independent **source-free model**, not compiler code, actual guest execution, or a trusted Rust differential check.

## Shared semantics

- `Init` produces a unique OwnerId on the full function, not just a branch. The same is true for `Borrow` and LoanId.
- `Copy` requires independently typechecked Copy evidence; `TaskCaptureCopy` requires both independently validated Copy and Send. Send never implies Copy.
- Move/Drop/TaskCaptureMove invalidate the original owner and cannot overlap a live loan.
- Multiple shared loans are permitted; a mutable loan excludes other loans. Owner writes overlap any live loan; `WriteThrough` requires the matching exclusive loan.
- Borrow/owner operations on unknown or moved places fail closed. Each terminal CFG block needs a distinct `Return` with no live loans.
- The restricted V0 admits only acyclic CFGs with consistent incoming ownership states. Divergent joins, raw actor-hop borrows, loans crossing suspend, unknown effects and foreign calls reject.
- Real AttoLang must eventually support sound loops, projected place trees, compiler-owned trait provenance, pinned continuation loans, cancellation, actor state, unwind/drop glue and arbitrary CFG joins. Current V0 rejections are limitations, **not permanent language rules**.

## What each compiler must implement

**Java/GraalVM:** continue integrated `OwnershipChecker`; use its typed MIR event producer. Its `atto-borrow-mir-v1-java-shadow` observer is intentionally **not** the canonical contract: ordinal event IDs, limited Copy return profile, no emission inventory.

**LLVM/C++:** use native `OwnershipCfg.hpp` and compiler-issued loan/write identities. Validate source-to-typed-MIR lowering and LLVM load/store/drop emission, including CFG and lifetime edges. No self-minted "pass" from a host-only model.

**.NET/C#:** typed CFG admission before CIL and NativeAOT, with explicit lifetime/loan operations. The existing scalar SSA subset has no general actor borrow checker.

**Wasm:** typed source frontend and owned linear memory/worker transfer fences; JS host runtime tests alone do not prove guest borrow checking.

**Forge/C++:** source frontend and verified IR before JIT/AOT emission; narrow scalar-only acceptance is legitimate, but not ownership parity.

**Cranelift/Rust:** typed frontend before CLIF lowering; can link the canonical Rust library directly when supported, but must authenticate source facts and exact generated program and reject unsupported operations.

## Evidence promotion

Manifest `evidence[backend].status` starts **NOT_EXECUTED** for all six. The test suite intentionally never returns `verified:true`, including for a synthetic self-contained receipt.

To count a *real* compiler differential result, bind independently:
1. Exact Git source commit/tree and complete path/mode/blob SHA manifest.
2. Compiler-version/toolchain identity plus actual runner admission, executed steps and logs.
3. Independently enumerated compiler-generated typed MIR (NodeId/PlaceId/LoanId/WriteId, type and effect proofs) and instruction count.
4. Verified emitted code/instruction inventory or exact compiler semantic-negative diagnostics.
5. Successful compiled `.atto` guests, NativeAOT where applicable, and one independently reviewed receipt per backend.

No source-free Node pass, zero-step GitHub run, fabricated `CERTIFIED` flag, or source-authored unit test is allowed to promote compiler parity.

## Native backend parity checkpoints

Run `node --test tests/borrow-mir-v1-contract.test.mjs` for a *source-free contract check*. Then run actual compiler-backed positive and negative fixtures against the same **logical cases**, with backend specific IR adapters and stable diagnostics. A feature the backend does not implement must **reject** before code emission, not silently skip the ownership event.

Related canonical Rust [PR #5](https://github.com/ores-truffle-oreslang/atto-borrow-checker.rs/pull/5), Java [PR #2752](https://github.com/ores-truffle-oreslang/oreslang-source.java/pull/2752), and [borrow-checker consolidation issue #3](https://github.com/ores-truffle-oreslang/atto-borrow-checker.rs/issues/3).

**Security:** private Git trees must not be exported across organizations without the protected private CI destination+snapshot authorization. Keeping identical contract blobs inside the original private source organization does not authorize alternate-org mirroring.
