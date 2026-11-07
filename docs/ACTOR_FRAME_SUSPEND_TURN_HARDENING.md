# Wasm actor managed-frame suspension-turn fence (M1 follow-up)

**Scope:** host-runtime hardening only, stacked on Wasm [#412](https://github.com/ores-truffle-oreslang/oreslang-source.wasm/pull/412). This is **not** compiled AttoLang actor execution, real Wasm call-stack isolation, or an approved actor scheduler.

## Finding

Parent M1 `ActorArena.suspendStack(turn, execution)` minted a one-use receipt, but `resumeStack(turn, receipt)` accepted it while **the issuing physical turn was still active**. This allowed a scheduler or buggy host callback to treat a local suspend/resume pair as though the actor had reached a real physical scheduling boundary. Receipt uniqueness alone does not prove a turn transition.

## Repair

- Each private logical stack stores the exact **issuing turn identity** alongside its pending suspension receipt.
- `resumeStack` checks the currently admitted, actor-owned physical turn. If it matches the issuing turn, it denies resumption **before consuming the receipt**. The active stack stays null, bytes remain pinned to the logical execution and the issuer must call `endTurn` before any next-turn resume.
- A distinct `beginTurn` token after `endTurn` may consume the one-use receipt and reactivate its exact execution.
- Cancellation and normal stack teardown clear the turn marker and revoke the receipt; actor retirement still fences all operations and lifetime pins still determine when byte scrubbing finishes.
- The marker is an **opaque private object identity**, not a caller-provided integer, timestamp or string. No new cross-actor, cross-generation, or guest-visible capability is introduced.

This is intentionally distinct from a full scheduler task/turn lease. The caller still must not expose receipt objects to untrusted guest code; future integration must bind them to scheduler-owned SourceTask, await, and actor incarnation credentials.

## Focused regression matrix

`tests/actor-frame-suspension-turn-fence.test.mjs` adds eight deterministic Node host-runtime tests:

1. Three consecutive same-turn resume attempts fail but leave frame bytes and ticket intact; later physical turn resumes correctly.
2. Two simultaneously suspended logical executions cannot resume early; each retains independent bytes and may resume in permitted order.
3. Rejected same-turn attempt neither consumes receipt nor enables `endTurn` while a stack is active again.
4. Cancellation revokes denied receipts and stale frame handles; new execution starts with clean bytes.
5. Foreign actor with the same numeric ID, forged/cloned receipt, and new incarnation all fail.
6. Supervisor STOP logically retires the actor while a lifetime pin delays physical scrub; old ticket cannot revive a new actor.
7. Actor B continues correctly despite actor A's premature resume attempt.
8. Primitive and fabricated receipts cannot become authority.

Run on the **exact PR head** with Node 22+:

```sh
node --test tests/actor-frame-suspension-turn-fence.test.mjs \
  tests/actor-frame-stacks.test.mjs \
  tests/actor-frame-stack-primordials.test.mjs \
  tests/actor-arena.test.mjs
npm test
```

## Explicit evidence and merge holds

These tests exercise a host `WebAssembly.Memory` model; they **do not** run compiler-generated `.atto` actors. Do not count the 8 new host tests as guest proof, per-actor engine stack isolation, production-safe untrusted tenants, hard real-time scheduling or native AOT.

Retain **DRAFT** pending independently reviewed, exact-head, nonzero-step Node execution of the parent and this branch. A workflow job with `steps=null` or `steps=[]` is runner-admission failure, not source/test failure. Do not mirror private Git trees across organizations.

Remaining P1 integration: wire a real pooled Wasm actor scheduling task identity to frame creation, await suspend/resume and shutdown; compile guest locals/roots/call recursion into checked frame layouts; test actor A overflow while B continues, and compare the same `.atto` guest traces against Java and LLVM.
