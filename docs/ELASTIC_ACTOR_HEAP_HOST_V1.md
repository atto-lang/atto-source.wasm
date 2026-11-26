# Elastic actor heap v1 — isolated host prototype (2026-11-09)

**Status: HOST_ONLY / NOT_EXECUTED_AS_COMPILER_GUEST / NOT_CERTIFIED.**

This is a deliberately separate experiment. It does **not** replace or
modify `src/actor-arena.mjs` and its fixed two-page layout. Do not attach
compiled guest modules, FFI raw pointers, task continuations, source actors,
untrusted direct JS callbacks, or asynchronous work to this prototype.

## Implementation and limits

- `src/elastic-actor-heap-v1.mjs` offers `ElasticActorHeapPoolV1`
  backed by one **non-shared** `WebAssembly.Memory` per simultaneously active
  actor. Per-pool hard maximum is 1..1024 Wasm pages (64 KiB..64 MiB).
- New memory begins with **zero logical Wasm pages**. This does not imply
  zero engine/JS host overhead or zero OS committed/resident memory. On first
  allocation, capacity grows in 64 KiB page increments with
  `WebAssembly.Memory.grow`; it never grows past the declared maximum.
- Allocation returns a private opaque handle. Diagnostic `word()` returns
  `byteOffset / 8 + 1`, with `0` reserved for null, but the word is **not
  an access capability** and native pointers are never exposed.
- Growth retains stable logical offsets and old live contents. Every read and
  write **reacquires the current memory buffer**; an old typed-array view
  cannot survive through the public interface. The locally executed suite also includes 4,000 seeded allocation, drop, restart, and quota operations. Native byte-array and Wasm
  memory intrinsics are captured once to resist poisoned prototypes.
- A turn token, actor ID, incarnation and issued allocation handle are
  required for access. Concurrent uses of one actor ID, even under different
  incarnations, are denied. Dropped allocations are scrubbed, invalidated,
  then reuse a first-fit free segment. Retirement is denied during an active
  turn, scrubs the entire heap, and returns only quiescent memory to the pool.
- An optional tenant ledger and mandatory process ledger are both charged
  **before** each grow. Failed quota admission or thrown Wasm growth rolls
  back the tentative reservations and leaves prior actor bytes intact.
  This is page-level **conservative logical backing accounting**, not a
  measurement or proof of physical RSS.
- Pooled memories remain charged until process-wide verified reclamation:
  retiring one actor **does not refund** page charges or claim physical free.
  The fully scrubbed memory can be handed to a future incarnation from the
  same trusted pool without recharging previously committed pages.
  `pool.retire()` drops references to idle buffers but does **not** refund
  the ledgers; JS engine collection/release is not guaranteed at that point.

## Security and integration holds

1. **Trusted host API only.** It is not a JS sandbox; callers with host-level
   access to exported ledgers can mutate reference accounting. Do not expose
   this module, its pool, ledger, handles, or `WebAssembly.Memory` through
   guest imports or adversarial JS in the same realm.
2. No real compiled AttoLang source guest object placement or type-checked
   native ref32 graph field loads/stores exist here. No source actor scheduler
   wiring, mailbox quotas, byte-for-byte data-structure lowering, or NativeAOT.
3. This host prototype deliberately excludes asynchronous guest callbacks,
   in-flight FFI loans and guest instances. Never recycle guest-bound heaps
   without scheduler-proven quiescence, borrowed-view fencing and definitive
   Worker/instance shutdown evidence.
4. Pool reuse is a one-tenant trusted host optimization, not authorization to
   share mutable Wasm linear memory across live actors. Tenant boundaries
   require separate pools and independent authenticated assignment.
5. Wasm memory growth does not shrink previously committed linear pages.
   Page budgets do not capture all runtime metadata/engine overhead; OS
   process/Worker limits and real RSS instrumentation remain mandatory.
6. Real-time/prefault actors must use a distinct admission policy; Wasm
   demand growth cannot count as a hard-real-time proof.
7. The production fixed two-page arena, `env.memory` import contract, and
   pointer/borrow/FFI layout must be explicitly versioned and reviewed
   **before** any codegen or guest integration.

## Evidence and exact source

Historical source-matching local Node 22.16.0 on the previous eight-test head:
`node --test tests/elastic-actor-heap-v1.test.mjs` — **8 passed, 0 failed**.

Current ten-test head: **10/10 passed only in an isolated V8 test harness with an emulated `WebAssembly.Memory`**, not real Wasm memory and not the real Node test runner. Exact-head Node, real WebAssembly and compiled AttoLang guest tests remain **NOT_EXECUTED**.

Local `git hash-object` of the executed files matched their GitHub blobs:

- Previously Node-executed runtime: `7326d684dd5324fc8ab8e278d0c892fa366a53d1`
- Previously Node-executed tests: `a2625320f9323f5be8ca8429a9a80e2c7a22442a`
- Current ten-test runtime (not Node executed): `fc11a69711d77d1a95a7e540fde6ebf3081c0e7c`
- Current ten-test file (not Node executed): `09e083ef84be0a84d43cf2ceb1d2887626859af4`

This is **host-only Node execution**, not a hosted GitHub Actions test, not a
real AttoLang guest, and not proof of actor-heap parity. Exact-head
stepful CI and independent security review remain required.

Relevant contracts: [platform #606](https://github.com/ores-truffle-oreslang/oreslang-platform-conformance/pull/606)
and [platform #643](https://github.com/ores-truffle-oreslang/oreslang-platform-conformance/pull/643).

## API admission repair

Pool page growth and memory recycle are private class operations and are reachable only from per-heap captured closures; neither can be invoked through the returned pool object. A client cannot pass a foreign memory object or a forged page count to charge/refund a trusted ledger, and growth independently validates the actor's hard maximum before reserving pages. The ninth test verifies that public-property monkeypatches cannot affect these operations. No guest or malicious-same-realm authorization claim follows from this host-only repair.

## 2026-11-10 bounded recycler hardening

Actor pool construction accepts `maxActors` (default 64, maximum 4096). It preallocates a fixed-length **host-only** idle-memory reference table and rejects additional concurrent actor leases at the explicit limit. Pool recycling now uses fixed indexed storage instead of `Array.push`, avoiding retirement-time dynamic idle-list expansion. The actor's retired/invalidated state is published only after full scrub and accepted recycle; a failed admission cannot strand a logically retired actor in an active identity set. The tenth test covers active-pool admission, scrubbed reuse, and hostile `Array.prototype.push` patching.

The first **eight-test** revision was executed with real Node 22.16.0. The **current ten-test** revision has only isolated V8 simulated-memory execution (10/10 pass); **real Node/WebAssembly execution of this exact source head is still NOT_EXECUTED**, as is compiler-created guest actor heap usage. No test title or successful synthetic carrier receipt upgrades this status.
