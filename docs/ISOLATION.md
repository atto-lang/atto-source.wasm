# Execution isolation contract and staged roadmap

## Admitted today: experimental scalar profile

`core-wasm.i64-v1` requires:
- core Wasm validation and exact `() -> i64` exported function;
- **no host imports**, start section or table section;
- exactly one private 32-bit linear memory, explicitly limited at link time to at most two 64-KiB pages by default;
- no shared memory, memory64, multi-memory, or unbounded expansion;
- required SHA-256 pin in the CLI (optional only for direct API callers performing local controlled tests), checked against an immutable execution snapshot;
- no WASI, clock, filesystem, network, environment variables or device host bindings;
- fresh Node worker per execution; validation, compilation, and guest execution happen inside the worker's wall-time deadline;
- admission cap of four live workers per main-thread module instance, with capacity released after termination.

This prevents guests from invoking unauthorized JS host imports through WebAssembly and prevents the normal guest linear-memory address space from being shared between invocations. It is a **defense-in-depth prototype**, not containment against vulnerabilities in the Wasm engine or operating system.

Memory maximum is checked against the binary, not just build flags. CLI file reads are capped before allocation, and the CLI requires an exact artifact SHA-256 pin. The standalone admission helper verifies that pinned hash on a byte snapshot before invoking the WebAssembly validator or compiler. Untrusted compilation runs within the disposable worker, not on the main thread. Node worker JS heap resourceLimits do not constrain all WASM/non-JS native allocations; the module-size, fixed guest linear-memory maximum, time deadline and OS-level deployment boundaries still matter.

## NOT proven

- Not a true Oreslang actor: no actor lifecycle, authenticated ActorRef, async continuations, mailbox protocol or transfer of an ownership-protected Oreslang heap.
- Not Native AOT: Node/V8 may compile core Wasm just in time.
- Not an OS sandbox: native Wasm execution remains in the same OS process as other workers.
- Not general Wasm Component Model or WASI 0.2/0.3 support.
- Not native CPU fuel metering; worker termination is a wall-time guard and can be delayed if the host event loop is blocked. The API does not report success or release a worker slot until termination completes.
- The four-worker admission cap is module-local, not a per-tenant or per-process aggregate quota across every Node context.
- Not a verified shared frontend or formal proof of semantic parity with other language backends.

## Next boundaries

1. Consume versioned, verified Oreslang MIR from a common frontend instead of duplicating parsing/type/borrow logic.
2. Stabilize actor message ABI (bounded serialized payloads, authenticated actor handles, generation IDs, ownership/borrow discipline, cancellation).
3. Define capability/effect manifest; enforce at source checker, link/import gate, and trusted host broker.
4. Add isolated actor instances and deterministic mailbox/continuation semantics, with each actor's private memory.
5. Add Wasmtime-based strict AOT host (precompile under trusted build conditions, pin host compatibility, reject untrusted serialized native artifacts) and OS process sandboxing for hostile tenants.
6. Add WIT component APIs with separate pinned WASI 0.2/0.3 profiles; no direct raw pointers across actor domains.
7. Attach real compiler binaries to `oreslang-platform-conformance` and test inter-backend behavior, not just harness self-tests.
8. Add fuzzing, differential compilation, crash/timeout, memory-exhaustion and formal state-machine checks.

CI should never treat stub compiler tests as evidence of Oreslang-to-Wasm actor support.
