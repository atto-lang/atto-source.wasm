# Actual compiler-generated Atto actor frame M2 — pooled Wasm acceptance

**Status: DRAFT; compiled guest execution NOT_EXECUTED on exact head.**

This source-repository change is stacked on Wasm [#416](https://github.com/ores-truffle-oreslang/oreslang-source.wasm/pull/416), which is stacked on #160 -> #154 -> #151, and depends on LLVM [#1544](https://github.com/ores-truffle-oreslang/oreslang-source.llvm/pull/1544) (stacked on LLVM #1350). It preserves the existing trusted-only source artifact admission, fixed private Wasm memory, four exported symbols and Worker physical retirement barrier. It does **not** merge, rewrite, export or authorize new source mirrors from these draft branches.

## Compiler-to-worker proof chain

The new `assertCompiledActorScalarFrameV1(ir)` checks source compiler IR **before** linking:

- Exactly one internal `@atto.wasm.actor.scalar.frame.v1` instance-private scalar array global, between 2 and 17 signed i64 cells.
- At least one explicit bounded GEP slot reference and at least two volatile i64 stores per slot (initialization + final scrub).
- Rejection of a source message slot silently lowered to native engine `alloca`.
- No acceptance of arbitrary source IR through this mechanism: the existing compiler binary SHA-256 pin, byte snapshots, source admission, `assertWasm32IrTarget`, Wasm import denial, strict binary actor ABI, non-growing two-page memory and accepted source-artifact digest checks remain in place.

Pass `requireActorFrameV1: true` to `compileSourceActorToWasm`, and provide canonical `.atto` source with an exact executable compiler SHA-256. Existing v0 callers remain supported but are **not** silently reported as M2.

The `tests/fixtures/wasm32-actor-owned-scalar-frame.atto` is **byte-identical** to the fixture in LLVM #1544: Git blob SHA-1 `c8d959234f3c04b7a8f14e0a4b6dc44aae5a3a1e`. The mandatory acceptance script verifies this blob with a real local Git-object hash, the pinned compiler binary with SHA-256, then starts exactly one Node TAP test requiring a non-skipped, successful real guest execution.

### Required execution

With the real LLVM #1544 compiler built and verified from its exact tree on an approved source carrier:

```sh
export ORESLANG_LLVM_COMPILER=/approved/source/build/oreslang-llvmc
export ORESLANG_LLVM_COMPILER_SHA256=<sha256 of exact executable>
npm test
npm run test:atto-pooled-frames
```

The mandatory script checks 1 test, 1 pass, 0 failures, 0 skipped and emits a signed-off-looking textual acceptance **only after actual execution**. It runs 8 real source-compiled guest actor instances over 2 Workers, 16 messages each, checks same-carrier STOP preserving the sibling, and verifies a replacement starts with clean state. The generated guest frame attestation is included in the provenance receipt.

`npm test` may skip the real source test if no compiler is configured; such a run must NEVER be interpreted as compiled-guest proof. Missing compiler, SHA mismatch, altered fixture, missing real guest execution or an incomplete TAP inventory fails the mandatory command with nonzero status.

### What this does not yet prove

- The fixed guest scalar frame is **inside each guest's private linear memory**, not a new independent Wasm engine call stack, and it is not address-aliased to the host-only managed frame ledger in Wasm #416.
- No dynamic recursion/64-frame actor stack compiler lowering, caller/callee frame roots, async suspension, `select`, actor stack migration, revocable cross-tenant capability, supervisor CONTROL, or trap-unwind guest frame cleanup is implemented.
- A Node Worker carrying several actors is **not** an OS sandbox; only independently trusted guest code is admissible. The hosted actor execution count is not evidence for untrusted actors or general WebAssembly AOT.
- The IR pattern checks are defense-in-depth and do not substitute for compiled actual guest and independent reviewed source→compiler→artifact provenance.

Next M3: reconcile authoritative actor/task generation, stack suspension, checked recursion without native engine stack overflow, actor A budget failure while actor B remains responsive, supervisor notice, Java/LLVM/Wasm compiled-guest parity and Wasmtime AOT proof. No merge or certification until exact-head nonzero-step CI and independent review.
