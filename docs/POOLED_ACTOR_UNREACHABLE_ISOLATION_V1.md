# Wasm pooled actors: fail-closed actor-local unreachable traps

**Scope:** source-owned, trusted-only, zero-import pooled WebAssembly actor runtime. Stacked on Wasm PR #415. This does **not** prove compiler-managed guest stack quotas, unbounded Wasm recursion containment, or full Java/LLVM actor fault parity.

## Why the distinction matters

The original pooled worker reports every guest trap as `fatal`, causing the host to terminate its entire Worker carrier and every co-located actor. Independent `WebAssembly.Instance` memories and host-managed logical frames did not themselves establish same-carrier actor failure isolation.

A WebAssembly `unreachable` instruction traps synchronously into `WebAssembly.RuntimeError("unreachable")`. For an import-free, private-memory, synchronous trusted actor instance, the worker can distinguish that *one exact trap class* from other errors, unwind the host managed frame, revoke the actor registration, scrub the actor's own Wasm memory, retire its ActorArena, and post a bounded `actor_fault` receipt to the host.

## Exact contained fault contract

- Only `send` turns with a genuine `WebAssembly.RuntimeError` whose message is exactly `unreachable` qualify. The worker checks the existing actor ID and random incarnation credential; guest code has no imports or access to the host worker.
- Before notifying the pool, it verifies zero active managed stacks, zero managed frame bytes and zero external lifetime pins, clears the actor identity, zeros its private two-page guest memory and retires its private host arena.
- The host verifies the active operation, ticket, actor ID/incarnation, exact `WASM_UNREACHABLE_V1` code, null result, protocol version, 16-byte host frame size, zero live frames and `retired=true`. Only then does it reject **every pending operation** on the retired actor, clear queued messages, update its isolated-fault counter and continue pumping the intact carrier for other actors.
- Every other guest trap, invalid ABI, malformed receipt, unconfirmed cleanup, timeout or unexpected Worker exit remains carrier-fatal and retains the preexisting physical-exit barrier before reclaiming actors.
- This receipt is a **trusted Worker-to-host runtime contract**, not an independent cryptographic guest proof. Do not grant guest code access to worker `parentPort` or message injection.

## Regression coverage

Five added Node/Clang-native-synthetic-Wasm tests extend `tests/pooled-managed-frame-worker.test.mjs`:

1. Two co-located actors run in one Worker; A executes a real `unreachable` Wasm instruction and is retired, B continues with unchanged state and a fresh actor starts with isolated memory.
2. Faulting actor A has queued DATA and STOP, all reject once A faults; co-located B continues.
3. Another engine fault (integer division by zero) remains **whole-carrier fatal**; B is not incorrectly acknowledged and the isolated-fault counter remains zero.
4. Forged `actor_fault` with `retired=false` is rejected and the entire carrier quarantined.
5. Forged `actor_fault` with an unapproved stack-overflow code is rejected; stack overflow is **not** silently classified as isolated.

Run on exact source HEAD using Node 22/24 and Clang wasm32:

```sh
node --test tests/pooled-managed-frame-worker.test.mjs
npm run test:managed-pooled-actors
npm test
```

If the Clang native wasm32 target is unavailable, these regressions are **NOT_EXECUTED**, not successful. A real `.atto` compiler-backed source actor gate is still separately required (upstream `npm run test:real-pooled-actors`).

## Remaining gaps and security holds

- `unreachable` proves a narrow synchronous guest-trap containment mechanism; **it does not prove** guest recursion overflow, native stack safety, Wasm engine stack ownership, generated `.atto` frame lowering, `await` continuations, supervisor CONTROL, cancellation across FFI or safe untrusted multitenancy.
- A trapped actor must be regenerated with a **new incarnation/identity**; its old message handle rejects subsequent sends.
- Do not broaden recovery to `RuntimeError: call stack exhausted`, out-of-bounds memory, general `RuntimeError` or `RangeError` without a compiler-owned bounded/trampolined frame ABI and independent JIT/AOT validation. A sufficiently hostile guest still needs an OS-level sandbox.
- Exact-head source-org Actions currently fails pre-step. GitHub provider diagnostic recorded in conformance [incident #315](https://github.com/ores-truffle-oreslang/oreslang-platform-conformance/issues/315) identifies failed payments **or** spending-limit admission; the account billing owner must determine the specific condition. This branch's host tests cannot be certified until an admitted runner records executed steps; do not transfer private source or waive independent review.
