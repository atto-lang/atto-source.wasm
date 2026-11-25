# AttoLang tenant/actor isolation — checked-offset contract v1

**Status: host-side boundary primitive, NOT a completed sandbox.** This is a
first step toward the two-tier design: one independently enforced tenant
security boundary, with multiple actor-owned heaps/stacks inside each tenant.
Oreslang repository names and legacy `.ores` source remain supported.

## Wire and ownership rules

- A stored compressed32 word is **unsigned 32-bit**. Word `0` is null.
  Nonzero words decode to actor-relative byte offset `(word - 1) * 8`.
  Maximum logical span is `0xffffffff * 8 = 34,359,738,360` bytes.
  The word is an offset, **never** a native machine pointer.
- Trusted actor allocation code mints a non-forgeable **per-gate allocation
  grant**. Each gate corresponds to one tenant, actor, and incarnation.
  A grant is valid only for its originally issued allocation interval.
  Cross-actor, cross-tenant, and restarted actor grants fail closed.
- Access requires a live issued grant, nonnull compressed word, positive
  access byte length and **subtract-first** containment:
  `offset >= start && offset <= end && accessBytes <= end - offset`.
  A numeric offset or reconstructed metadata object is not authority.
- Live allocations cannot overlap; dropping an allocation invalidates its old
  grant even if the same bytes are reused. Retirement revokes every grant.
- The real allocator/supervisor must separately ensure correct physical memory
  scrubbing, quiesced actor turns, FFI pin retirement, stack guard handling,
  cancellation, and generation-safe resource/capability handles.
- Any interface admitting `untrusted`, `vm-isolate`, `process-sandbox`,
  or equivalent must **reject** unless its enforcement mechanism has been
  independently verified. A separate heap, JS Worker, CLR object registry,
  Graal `Context`, or a C++/Rust check helper is not an OS sandbox.

## Scope and evidence

The checked-offset helper in this PR is a **trusted-host reference primitive**.
Native code that can freely dereference a host pointer can bypass it; a Wasm
instance sharing one linear memory with other actors can also read arbitrary
bytes inside that instance unless access lowering confines it. A guest-memory
security claim requires proof that *every* load/store and host import passes
through an equivalent unavoidable check. No such claim is made here.

Tests exercise: positive boundary, null word, word overflow/high bits where
applicable, byte-count overflow, cross-actor/cross-tenant grants, actor restart,
stale grant/ABA reuse, live overlap, maximum u32 word, retirement, sibling
survival. Results from host models must not be called compiler-backed guest
execution or native tenant sandbox evidence. Zero-step CI is NOT_EXECUTED.

## Next integration gates (not yet established by this change)

1. Lower actual `.atto`/.ores guest loads and stores to the allocation gate
   in **every** production backend; prohibit raw pointer escape.
2. Bind allocation grants to per-tenant VM/isolate authority and the scheduler's
   exact actor incarnation. Make host interop and imported JVM/.NET libraries
   capability-scoped; revoke on quiescence and actor restart.
3. Demonstrate actor-specific stack overflow containment without crashing
   sibling actors or the process; validate guard-page and signal handling.
4. Demonstrate tenant confinement against intentionally corrupted guest
   pointers, Wasm linear-memory escapes, JIT/AOT miscompilation, stale FFI
   callbacks and side channels. Escalate untrusted native tenants to verified
   process/microVM/Wasm isolation where appropriate.
5. Collect independently executed exact-head tests and negative-mutation
   receipts for Java/Graal, LLVM, .NET NativeAOT, Wasm (browser and Node),
   Forge, Rust, JavaScript and hardware-only backends. Never present this
   staged helper as a completed multi-tenant security sandbox.
