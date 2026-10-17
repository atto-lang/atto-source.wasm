# Actor arena quiescence v1

Status: **candidate / exact-head runtime execution pending** (2026-10-17).

This contract applies to the current Java/GraalVM, LLVM, .NET, Wasm and Forge
actor-arena hardening stacks. It defines reclamation semantics only. It does
not certify guest-language lowering, Native Image/NativeAOT/Wasmtime execution,
full zero-GC operation, or production readiness.

## Required semantics

1. Actor retirement closes admission immediately. No new turn, allocation,
   arena read/write/drop, or guest memory authority may be created after logical
   retirement.
2. Physical reclaim must wait for every authority that can still depend on the
   backing storage: active turns, live read borrows where the backend exposes
   them, and external continuation/FFI/I/O lifetime owners.
3. External lifetime authority is intentionally weaker than memory authority.
   It must not expose a raw pointer, MemorySegment, slot, mutable span, Wasm
   backing buffer, or any equivalent dereference operation.
4. External release may execute on a callback/completion carrier different from
   the actor turn carrier.
5. Duplicate cleanup is harmless. If a backend reuses a bounded lease slot,
   stale authority from an older generation must not release the newer owner.
6. Reclaim failure must never publish dirty/reusable capacity or falsely mark
   physical reclamation complete. Cleanup remains retryable or fails stop.
7. Reused capacity is scrubbed before another actor can observe it. Quota and
   ownership accounting underflow/overflow fail closed.
8. A source-free contract pass is not runtime certification. Exact-head CI,
   guest lowering, native AOT and zero-host-GC flags remain false until separately
   evidenced.

## Current backend mapping

- Java: FFM regions use lifetime-only pins in addition to read loans.
- LLVM: native heap uses generation-checked external lease slots.
- .NET: unmanaged arena uses opaque idempotent ExternalLease objects.
- Wasm: fixed-capacity runtime page pool delays page return while externally pinned.
- Forge: native arena uses move-only RAII ExternalLease lifetime authority.

All five remain candidate implementations pending exact-head runtime execution.
