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

## Single-use WAKE replay fence (2026-11-12 update)

The ledger now refuses to `startOrResume` a suspended task. `suspend` returns a fresh opaque ledger-issued object per suspension. The trusted physical actor WAKE dispatcher must validate its carrier lease and Future source before invoking `resumeFromWake`; it consumes that exact ticket to transition back to running. Foreign tickets, wrong task, replay after resume, older tickets after a later suspension, and STOP are denied. The mutable single-writer lease remains checked. This is a *logical host replay guard*, not yet a compiler/physical-WAKE authority integration.

Exact committed Git blobs of the new host test:
- `src/actor-task-lifecycle.mjs`: `6e6060d3e6f2bf338c7dc1974d1f7596451cb1ef`
- `tests/actor-task-lifecycle.test.mjs`: `d0a640d65a9d6216b527e06f5c19c7c54fd8cd2d`

Local Node v22.16.0: `node --test tests/actor-task-lifecycle.test.mjs` **8/8 passed**, 0 failed; output SHA-256 `fb4d6d18167ae68ff25295ec9830380ed852db22a3eee47e9c1ee347d7752063`. Host-only exact blob evidence; no compiled `.atto` task/await guest or full `npm test` receipt exists. Source-org GitHub Actions jobs remain zero-step / NOT_EXECUTED.
