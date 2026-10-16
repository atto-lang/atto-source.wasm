# Oreslang CPU/GPU execution expressions and `nb` graph contract — v1 proposal

**Status (2026-10-16): proposed source semantics, NOT executable source lowering.**
This document is mirrored across `oreslang-source.java`, `oreslang-source.llvm`,
`oreslang-source.net`, `oreslang-source.wasm` and `oreslang-source.forge`.
The reference implementation is Java/Graal *by category*, not a license to
claim parity where the backends differ. Every backend must fail closed until
it implements AST, effects, ownership, graph lowering and actual execution.
No implicit GPU→CPU fallback is ever permitted.

## Decision: placement, nonblocking, stream are three independent axes

`cpu` and `gpu` select an **execution domain**. `nb` requests a
nonblocking task submission. A stream is a **separate, explicit,
backpressured producer/consumer contract**; `nb` alone does not create one.

| Form | Result | Semantics |
|---|---|---|
| `cpu { body }` | `T` | Join a CPU computation before producing `T` |
| `gpu { body }` | `T` | Join a device computation before producing `T` |
| `nb cpu { body }` | `Future<T>` | Submit a CPU graph, complete once |
| `nb gpu { body }` | `Future<T>` | Submit a GPU graph, complete once |
| `nb select ...` | unchanged | Existing nonblocking select; not placement |
| `nb gpu { writech(output, value); ... }` | `Future<Unit>`, plus separately declared `Channel<V>` | Explicit bounded streaming via channels |

Here `T` is the **actual resulting expression type**, not necessarily a
host-owned primitive. GPU results normally contain opaque device-resident
values (`GpuBuffer<T>` or a typed device scalar) until an explicitly
authorized download. Neither `nb` nor assignment downloads device data.
No implicit blocking wait is inserted into a nonblocking expression.

**Empty block:** the proposed first-class singleton `Unit` (`()` value)
is the result of an empty block. It is *not* a unary number or uninitialized
value. `void` remains the existing no-return API annotation; compilers need
an agreed `Unit` representation before accepting
`const x = gpu {};`. The last value expression without a semicolon is the
proposed region result, or an explicit value-result form can be selected by
the grammar team; an ordinary `return` must not silently return from the
enclosing routine. This is not existing parser behavior.

## Separate execution regions from anonymous GPU kernel declarations

Older Java GPU experiments accepted `const fn = gpu { ... };` as an
**anonymous zero-argument GPU kernel callable** (e.g. Java PR #98). This
conflicts *exactly* with the proposed eager region expression of the same
spelling. We choose `gpu { ... }` as an **eager graph region** for this
proposal, and reserve `gpu () { ... }` / `gpu (typed params) { ... }`
for explicitly callable kernels. This is a deliberate prospective language
change, **not a backwards-compatible parser edit**. Do not enable both
meanings based on type context or guessed launch behavior. Finish an audit
of existing runnable kernel fixtures, calls and formatter output before
lifting Java's current fail-closed gate. A separate `gpu fnc` declaration
remains a statically typed callable kernel.

## Structured nested execution (host graph, not device recursion)

```ores
// DESIGN FIXTURE ONLY: not yet accepted as executable .ores source.
pub routine sample(): void {
    const empty = gpu {};               // Unit, *after* GPU completion
    const future = nb gpu {              // Future<Unit>, not a Channel
        const first = cpu { 21 * 2 };    // typed CPU step; waits for input deps
        const second = gpu { first * 2 };// explicit GPU-safe scalar lowering needed
        const third = cpu { second };    // illegal *as host data* absent download
    };
}
```

The last assignment intentionally illustrates a **rejection**: a
device-resident value must not be used as host data without a checked
transfer. All illustrated syntax remains fail closed until the full typed
ABI exists.

`gpu { cpu { gpu {} } }` is a **graph of ordered host and device
continuations**: finish/fence the enclosing device segment, run the CPU
continuation on a host carrier, then explicitly dispatch the next GPU
segment. It never means a GPU work-item can call back into arbitrary host
code, dynamically launch a new kernel, or block an actor carrier. A compiler
may fuse adjacent segments only after proving equivalent dependencies,
effects, ownership, memory visibility and error ordering.

A GPU region without explicit launch geometry must not fabricate a
one-work-item launch or one output per work-item. SIMT mapping must carry
explicit dimension/extent/shape, or derive extent from a unique,
checked device buffer under the preexisting validated kernel rules.
Scalar results require an explicit reduction/unique-writer proof.

## Required typed lowering and runtime guarantees

1. **AST/IR**: `ExecutionRegion(domain, synchronous|nb, resultType,
   effects, children)` and explicit `Transfer`, `Fence`, `Launch`,
   `HostContinuation`, `Await`, `Publish` nodes. Host and GPU segments
   may be nested in source but not secretly executed in the other domain.
2. **Type/effect**: `Host`, `Device(device capability)`, `Transfer`,
   `Suspend`, `StreamWrite` effects checked against routine `with`
   bounds. Device-safe kernels reject host I/O, actor mailbox operations,
   blocking waits, host pointers, panic/unwind, unbounded recursion and
   unsupported dynamic allocation.
3. **Transfer and layout**: typed allocation/generation/device/tenant
   provenance, owned host and device buffers, checked AoS/SoA/AoSoA layout,
   shape, strides, padding/alignment and ABI widths. Require explicit
   `Gpu.upload`, `Gpu.download` or peer transfer with a checked fence.
   Borrowed actor state must not escape/cross suspension or device
   execution; no mutable host/device aliases.
4. **Completion and errors**: `Future<T>` resolves only after actual
   command completion and required resource release. Failure, device loss
   and unavailable backend propagate as typed failures. Cancellation is
   a request, **not** physical GPU quiescence. No stale generation can
   publish results or refund credits early.
5. **Structured concurrency**: a nested `nb` child either joins,
   transfers an owned task handle explicitly or is cancelled and drained
   at scope exit; no implicit fire-and-forget. Preserve the actor's
   single-flight native execution, including completion races.
6. **Backpressure and streaming**: a `Channel<V>`/explicit stream has
   bounded element and byte capacities, ownership transfer on each
   message, exactly-once close/failure semantics, cancellation that
   unblocks producers/consumers and completion fences for device buffers.
   Kernel work-items cannot directly call host `writech`; the host
   continuation publishes checked completed tiles/batches. A future
   first-class `Stream<V>` syntax must be a **distinct marker** and lower
   to the same bounded protocol, never inferred from `nb` alone.
7. **Deterministic admission**: unsupported syntax (including nested
   `nb cpu` / `nb gpu`) must error without partial IR, host execution,
   CPU fallback, unbounded queues or dishonest capability advertising.

## Portable parity vectors / required tests

- Accept in future: synchronous CPU and GPU regions with `Unit` and
  expression values; nested CPU→GPU→CPU→GPU graph with checked explicit
  transfers; `Future<T>` and independent bounded `Channel<T>` streams.
- Reject until supported: `gpu {}`, `cpu {}`, `nb gpu {}`, `nb cpu {}`,
  `gpu { cpu { gpu {} } }`, `nb gpu { nb cpu {} }`, and GPU callable
  syntax on a backend lacking trusted lowering.
- Reject even after implementation: implicit GPU→CPU download,
  host I/O from a device kernel, actor-state loan crossing suspension,
  double-moved buffers, stale completion, unsupported device geometry,
  nonbounded stream, missing GPU capability and CPU fallback.
- Positive control: `gpu`, `cpu`, `nb` words inside comments and
  string literals are not execution boundaries. Plain i64 scalar
  programs must continue to compile on bootstrapped backends.

## Implementation and merge gates

- Java: reconcile merged domain admission (#700) with legacy GPU
  callable/kernel work (#98) and draft DOP planner (#1066) / CPU regions
  (#1086). Source grammar and owned buffer/graph binding are **not
  currently executable** by this proposal.
- LLVM: reconcile branch #229's fail-closed lexer/parser and draft
  accelerator source compiler (#83) with authoritative actor scheduler.
- .NET and Forge: currently only scalar i64 source programs; retain
  explicit rejection until typed graph and device ABI are real.
- Wasm: delegates compilation to LLVM and has a zero-import core-Wasm
  sandbox. GPU execution needs an explicitly capability-bearing new
  host/profile and validated ABI, **not** a fake GPU inside the zero-
  capability guest. Nonblocking/channel operations likewise require a
  different host ABI.
- Verification: exact-branch parser negative/positive tests first, then
  source-to-typed-IR golden tests, CPU graph execution, transfer/fence
  cancellation races, real OpenCL hardware (not a CPU ICD), cross-backend
  corpus, ASan/UBSan, and full CI. Mirror exact Git trees to funded
  runners if required; a different tree is not validation evidence.

This document is a target contract and must never be cited as working
GPU or streaming support.
