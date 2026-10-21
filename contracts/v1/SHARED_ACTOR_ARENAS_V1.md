# Shared actor arenas v1 — cross-backend normative contract

Status: **proposed/runtime-integration pending** (2026-10-16). Applies to Java/GraalVM, LLVM, Wasm, Forge and .NET. Does not assert guest-language/compiler parity.

## Architecture

- Every actor incarnation (including a SHARED actor) owns a logically private **persistent arena** for its state and a **scratch arena** for turn-scoped temporaries. An ActorRef conveys mailbox authority, never arena access.
- SHARED is an **execution/communication domain**, not an exemption from ownership. Sharing data requires an **explicit domain-owned shared arena** and independently validated capability (`rt share` at source level once lowering exists).
- Share immutable frozen values by default. Mutable shared regions require capability-scoped synchronization (`critical-read`/`critical-write` or equivalent), not a raw pointer or unsynchronized alias. A shared arena is separate from an actor-local arena.
- Trusted host/code images and supervisor CONTROL state are not part of guest shared data. UNTRUSTED actors retain their per-actor logical arena inside the **single pooled untrusted Graal isolate**, without new per-actor isolates. Trusted and untrusted address spaces must not exchange pointers.

## State and lifetimes

1. Create a unique `domain_id`, nonzero `incarnation`, region generation and bounded byte/slot quotas. Charge both actor/local and shared-domain aggregate budgets before allocation. Overflow and allocation failures must not change counters.
2. Persistent allocations outlive turns but not actor retirement. Scratch allocations are associated with the admitted turn epoch; they are invalidated and cleared on **every** turn exit, including exception, cancellation and suspend/cooperate. Suspending with a scratch borrow is rejected unless lowered into a pinned, independently lifetime-checked continuation allocation.
3. Every handle identifies `(arena_id, slot_or_offset, generation, incarnation)`; a shared capability also includes domain, rights and an unforgeable authority check. Handles are not serializable pointers. Validate before *every* read/write/drop and reject foreign, stale, exhausted and out-of-bounds access.
4. Actor-local mutation requires its actor execution lease, even when a carrier thread migrates. Shared-data mutation requires the shared-region synchronization lease. Read leases exclude writes; write leases exclude all others, with fair admission policy specified at the synchronization layer.
5. Actor stop closes admission and revokes new operations. Physical free waits for active turns, continuations, outstanding borrows, shared-region leases, mailbox producer admissions, I/O/FFI callbacks and all owning member references to quiesce. Retirement is monotonic/idempotent; stale generations must never wrap.
6. Drop nontrivial values **exactly once in a deterministic order** before bulk reclaim. A bump allocator alone does not run destructors. Zeroize data on teardown/reuse where confidentiality is required; use explicit native release for mmap/native segments. Never rely on Java/.NET finalizers for correctness.
7. A supervisor and child may hold shared-domain leases; parent shutdown alone does not free the shared region. The shared-domain arena is retired only when all owners and borrowers are quiescent. Never hold a shared-region lock while invoking arbitrary guest callbacks.

## Backend mapping and honesty boundary

| Backend | Allocation substrate | Current source parity gate |
| --- | --- | --- |
| Java/GraalVM | Existing actor-owned FFM region prototypes; stable JDK 22+ `java.lang.foreign.Arena.ofShared()` for multi-carrier native segments and bounded slicing; keep managed wrapper/control objects on GC heap | Integrate existing arena draft with source fields, turn suspension/cleanup, shared-domain leases, quiescence and JDK baseline (current main compiles `--release 21`) |
| LLVM | Existing `ActorArena` persistent fixed slab + epoch scratch bump; generational handles and retirement/loan accounting | Typed object lowering, destructors, shared-domain lease and scheduler integration, strict native no-tracing-GC audit |
| Wasm | Bounded private linear memory and offset/generation arena metadata; no unsafe host pointers; per-Worker or per-instance private arenas | Current host only supports scalar i64 guest ABI; SHARED actors/threads and actual guest actor arena lowering **unsupported** |
| Forge | Bounded C++ fixed/slab arena; handle table, RAII explicit drops for nontrivial values | Current Forge actor runtime only implements mailbox bytes; guest arena lowering and shared domain unsupported |
| .NET | Bounded unmanaged slabs via `NativeMemory.AlignedAlloc` / `AlignedFree` or managed pool when non-deterministic fallback explicitly allowed; generation handles | Current .NET runtime uses managed `byte[]` mailbox copies; source actor arena lowering and guaranteed zero-GC unsupported |

LLVM's `llvm::BumpPtrAllocator` is a *compiler* utility, not automatically the allocator for emitted guest state. `Arena.ofShared()` means multi-thread-capable lifetime management, **not** permission to mutate unsynchronized memory. Wasm linear memories are not OS protection domains. Arenas are subregions, not security sandboxes. Neither Java nor .NET may claim zero host GC simply because guest state is off-heap.

## Conformance gates before promoting to production

- Actor A cannot dereference actor B's private handle; ActorRef sharing grants no heap access.
- Persistent state survives turns and carrier migration; scratch survives neither end-of-turn nor suspension.
- Cross-arena handle replay, stale generation after reuse/restart, wrong incarnation, forged shared capability and ABA are rejected.
- Concurrent writer/readers, mid-write close, simultaneous retire, double close and stale loans cannot cause use-after-free, races or accounting underflow.
- Shared descendants and supervisor leases keep a domain alive after a parent actor stops; final lease release triggers physical free and no premature reuse.
- Quota exhaustion, overflow, alignment, zero length, max allocation, failing FFI destructor, process cancellation and leaked callbacks have explicit fail-closed outcomes.
- Test actual compiled Oreslang source on each backend, not just an allocator host unit test. Add fuzz/property tests, ASan/UBSan for native paths, JVM native-image and .NET AOT/GC allocation profiling.

## Suggested implementation order

First wire actor persistent/scratch arenas without guest-visible pointers; then add domain-owned shared regions with typed leases; then compiler allocation/drop lowering and suspension proofs; finally cross-backend source-level conformance and benchmarked hot-path performance. Keep every unsupported case rejected.

Related tracked work: Java #288/#289/#304/#575/#633 and arena drafts #580/#699; LLVM actor arena docs and issue #17.
