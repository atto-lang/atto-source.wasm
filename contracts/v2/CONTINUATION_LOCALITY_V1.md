# Continuation locality and actor execution safety v1

Status: **normative target and host-only reference-model tests**. This does NOT establish native Oreslang guest parity.

## Priority order

1. Authenticate tenant, scheduler domain, actor generation, code/descriptor generation, cancellation and deadline **before** publishing a runnable continuation. A stale continuation never executes.
2. Await releases the OS carrier. No JVM monitor, OS mutex, .NET Monitor or Wasm spinlock survives suspension. A non-reentrant actor may retain a *logical*, generation-fenced turn reservation; this is not a physical lock.
3. I/O and foreign-completion callbacks only signal readiness. Guest actor code runs solely after trusted scheduler admission.
4. Preserve CONTROL priority, non-reentrancy, domain isolation, bounded queues, and fairness before attempting locality.
5. Use an optional generation-fenced preferred-worker token within one scheduler domain. Prefer the same worker while its queued load is within a bounded slack of the minimum eligible load. Otherwise migrate promptly. Never reserve an idle carrier for an awaiting task.
6. Soft affinity is never physical CPU pinning: even the same OS thread may migrate CPUs. Explicit hard CPU affinity is an administrator constraint and cannot be bypassed by spill.
7. A stale worker hint only forfeits the preference; stale actor/code identity denies the resume. A retired actor never resumes in a new incarnation. No cross-tenant work stealing.
8. A contended critical acquisition may suspend *before* the body; execution inside a critical region must never suspend. Timeouts cannot interrupt half-completed protected mutation.
9. On an empty eligible-worker set, return unavailable/deferred, not inline execution on the producer/completion thread.

## Proposed internal hint (not guest ABI)

preferred_worker_slot and preferred_worker_generation are scheduler-local metadata. Tenant/domain, actor identity/generation and code/descriptor generation are **separate authoritative fields**. Do not use raw pthread, Java Thread, .NET Thread or Web Worker pointers as guest capabilities. NUMA locality is a preference, not permission to access foreign actor heaps.

## Verification and limits

The adjacent test_continuation_locality_v1.py runs 18 deterministic reference-model checks, including an adversarial property sweep. It is HOST-ONLY and does not exercise actual scheduler integration, the Oreslang compiler, continuation transfer, physical placement, cancellation paths or critical lowering.

Minimum exact-head **native guest** acceptance for each backend: await releases the carrier; reactor/foreign completion cannot run guest code; one actor never reenters during await; stale cancel/STOP/hot-load continuations are rejected; work progresses under overload/shutdown; CONTROL deadlines are preserved; critical bodies reject transitive suspension; actor-owned heap access survives safe worker migration. Preserve executable test receipts, compiler binary hash, guest stdout/exit code and CI job steps. A zero-step CI failure is not test evidence.

Java has soft actor-lane spill implementation and LLVM has a native scheduler with wake escrow, but this repository-level reference suite does not prove they are wired to an Oreslang continuation. Wasm/.NET have separate host-side actor machinery. Cranelift must reject unsupported suspending features instead of silently accepting them.

To run the reference suite: python3 -m unittest contracts/v2/test_continuation_locality_v1.py
