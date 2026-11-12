# AttoLang actor-task parity — Wasm substrate (2026-11-12)

**Status: trusted Worker host lifecycle bookkeeping. NOT `.atto` task/await guest parity.**

`src/actor-task-lifecycle.mjs` supplies opaque per-ledger task identities, bounded slots, nested task cancellation, explicit STOP and physical-retirement state. `src/pooled-actor-worker.mjs` now seals the ledger and denies teardown if a future continuation bridge leaves any task outstanding. The Worker currently exposes only the existing fixed scalar actor ABI, and no task is admitted by a real guest compiler.

The ledger runs inside the carrier Worker; it is not a source interpreter, Promise-based stand-in for compiled `task {}`, or privilege for an external Future producer. A future compiler bridge must authenticate the *physical owning actor turn*, preserve non-reentrant state access, lower suspended frames in actor-owned linear memory, and deliver resumes via validated WAKE tickets. The host must never resume on ROOT/CONTROL or producer threads.

Test the current host substrate:

```sh
node --test tests/actor-task-lifecycle.test.mjs
node --test tests/pooled-actors.test.mjs
npm test
```

**Still required for parity:** positive and negative real `.atto` compiler tests, `suspends/await` lowering, structured child scopes, cross-actor concurrency and fairness, generation-fenced STOP/late-Future integration, and actual wasm32 guest execution with exact-head receipts. Zero-step or host-only tests cannot satisfy those gates. The current design supports managed host GC with isolated Wasm linear memory; it makes no process-wide zero-GC claim.
