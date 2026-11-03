# Execution isolation contract and staged roadmap

## Admitted today: experimental scalar profile

`core-wasm.i64-v1` requires:
- core Wasm validation and exact `() -> i64` exported function;
- **no host imports**, start section or table section;
- exactly one private 32-bit linear memory, explicitly limited at link time to at most two 64-KiB pages by default;
- no shared memory, memory64, multi-memory, or unbounded expansion;
- required SHA-256 pin in the CLI (optional only for direct API callers performing local controlled tests), checked against an immutable execution snapshot;
- no WASI, clock, filesystem, network, environment variables or device host bindings;
- worker startup clears inherited environment variables and Node execution flags;
- fresh Node worker per execution; validation, compilation, and guest execution happen inside the worker's wall-time deadline;
- admission cap of four live workers per main-thread module instance, with capacity released after termination.

This prevents guests from invoking unauthorized JS host imports through WebAssembly and prevents the normal guest linear-memory address space from being shared between invocations. It is a **defense-in-depth prototype**, not containment against vulnerabilities in the Wasm engine or operating system.

### Async-only I/O boundary

The scalar profile is stricter than an async stdlib: it has **zero guest I/O**.
`core` therefore cannot fall back to synchronous WASI, Node filesystem/network
APIs, or worker-offloaded blocking calls. `compileAdmittedCoreGuest` rejects
legacy/blocking I/O mode, requested guest network I/O, and reactor options
before guest compilation. Any future stdlib profile must be separately
versioned and may expose I/O only through explicit asynchronous host-mediated
capabilities and continuation completion; broad WASI imports must never become
the default.

`tests/async-io-zero-capability.test.mjs` is part of the default `npm test`
suite. It executes a real import-free core module, requires
`imports == 0` and `hostCapabilities == 0`, checks that unsupported I/O
options fail before guest compilation, rejects even an empty Wasm import
section, and verifies that the worker instantiates with an empty import object.

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
5. Add Wasmtime-based tenant host with governed JIT as a first-class option, optional strict-AOT/precompiled execution, checked module provenance, resource/interrupt controls and OS process sandboxing for hostile tenants. Never load untrusted serialized native engine artifacts.
6. Add WIT component APIs with separate pinned WASI 0.2/0.3 profiles; no direct raw pointers across actor domains.
7. Attach real compiler binaries to `oreslang-platform-conformance` and test inter-backend behavior, not just harness self-tests.
8. Add fuzzing, differential compilation, crash/timeout, memory-exhaustion and formal state-machine checks.

CI should never treat stub compiler tests as evidence of Oreslang-to-Wasm actor support.

## Compiled module identity

The worker instantiates precisely the one WebAssembly.Module compiled from the
fully admitted immutable byte snapshot. It must not compile again using a
separate mutable view after admission. The legacy `admitCoreGuest` API still
returns only frozen validation metadata; the execution-specific helper returns
the compiled module privately to the disposable worker.

Host environment and execution-argument stripping are defense in depth, not
protection from native engine vulnerabilities. Process isolation is still
required for hostile tenants.

## Shared-buffer and worker-reply admission (October 2026)

The scalar input boundary rejects all `SharedArrayBuffer`-backed views,
including cross-realm objects. Hashes are computed only from private byte
snapshots. No user-owned backing buffer is transferred to a guest worker.
The parent also validates the complete worker-reported admission envelope
(version, profile, function entry, input size, SHA pin if present, fixed-memory
budget and zero capabilities) before returning a successful result. These
checks prevent accidental success from inconsistent internal metadata but
do not turn the Node Worker API into an OS-level security boundary.

## AttoLang untrusted JIT policy (candidate; not runtime parity)

Untrusted guest actors **do not require AOT**. Execution mode (JIT/AOT/
interpreter) is orthogonal to actor trust. A Wasm JIT may be chosen when the
supervisor independently enforces OS process isolation, bounded JIT compilation
and executable-memory policy, module identity, memory and host-resource quotas,
capability/host-import denial, interruption (fuel/epoch where available),
worker termination and generation/retirement fences. A Wasm Store, V8 isolate
or Node Worker by itself is not an OS security boundary. Hostile code must not
be promoted from this current scalar prototype to a sandboxed actor claim.

Contract and 32 source-free policy tests:
[platform-conformance draft PR #332](https://github.com/ores-truffle-oreslang/oreslang-platform-conformance/pull/332).
The existing Node worker compiler may already JIT core Wasm; that does not
establish real AttoLang actor lowering, Wasmtime/OS sandbox enforcement, or
backend guest execution proof.
