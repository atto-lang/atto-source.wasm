# Oreslang CPU/GPU execution expressions and `nb` graph contract — v1 proposal

**Status (2026-10-16): proposed source semantics, NOT executable source lowering.**
This document is mirrored across `oreslang-source.java`, `oreslang-source.llvm`,
`oreslang-source.net`, `oreslang-source.wasm` and `oreslang-source.forge`.
The reference implementation is Java/Graal *by category*, not a license to
claim parity where the backends differ. Every backend must fail closed until
it implements AST, effects, ownership, graph lowering and actual execution.
No implicit GPU→CPU fallback is ever permitted.

**Normative precedence:** source-level no-value and empty-GPU rules follow
`contracts/v1/CPU_GPU_NB_V1.md`: `void`/`Future<void>`, with no implicit `Unit`
value and no fabricated empty GPU launch. Host-only graph executors may retain
an internal `Unit` sentinel without exposing it through `.ores` source typing.

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
| Explicit host-owned `Channel<V>` publication after a completed region | `Future<void>` for a no-value host publishing task, plus a separately declared `Channel<V>` | A GPU kernel cannot call `writech`; a bounded host continuation publishes the completed value |

Here `T` is the **actual resulting expression type**, not necessarily a
host-owned primitive. GPU results normally contain opaque device-resident
values (`GpuBuffer<T>` or a typed device scalar) until an explicitly
authorized download. Neither `nb` nor assignment downloads device data.
No implicit blocking wait is inserted into a nonblocking expression.

**No-value blocks:** a region that performs allowed effects but has no value
tail has a `void` result. `nb` wraps that result as `Future<void>`. There is
no source-level `Unit` singleton introduced by the v1 execution-region
contract. In particular, `const x = cpu { effect(); };` is not a legal
value binding, and a bare empty `gpu {}` is rejected rather than fabricating
a kernel launch, result, or completion value. An effectful `gpu { ... }` may
be a statement only once the typed launch and device-effect checks exist.
An internal host-graph `Unit` completion sentinel is an implementation detail,
not an Oreslang expression value or an alternate type spelling. The last
value expression without a semicolon is the proposed region result, or an
explicit value-result form can be selected by the grammar team; ordinary
`return` must not silently return from the enclosing routine. This is not
existing parser behavior.

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
    cpu { log_metric(); }                // effect-only host region: void
    const future = nb gpu {              // Future<void>, not a Channel
        kernel_write(output);           // illustrative GPU-safe effect
    };
    // A subsequent host continuation must await a real completion fence.
    // An implicit GPU->CPU read of `output` is still illegal.
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

- Accept in future: synchronous CPU and effectful GPU regions with typed
  expression values or `void` statements; nested CPU→GPU→CPU→GPU graph with
  checked explicit transfers; `Future<T>` (including `Future<void>`) and
  independently bounded `Channel<T>` streams. An empty GPU region remains
  invalid and cannot be used as a value.
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

## Implementation progress on feature branches (2026-10-16)

These components now exist **as trusted host-side code only**; the normal
source parser still does not execute nested `cpu { ... }` / `gpu { ... }`
blocks, and no general GPU backend is enabled by this contract.

| Backend | Host-side implementation | Source-language execution |
| --- | --- | --- |
| Java | `ExecutionGraphV1`: immutable typed host graph, **internal** `Unit` completion sentinel, checked i64 CPU steps, OresFuture, cancellation; `ExecutionSurfaceV1`: eager region vs `gpu () {}` callable disambiguation; `ExecutionGraphChannelV1`: one-value publication into explicitly bounded ChannelRuntime | Not enabled; no source-level `Unit` admission; real AST/type/effect/owned region integration required |
| LLVM | `ExecutionGraphV1.hpp`: typed graph, checked native CPU steps, cancellable one-shot futures, strict device/transfer refusal | Not enabled; general source lowering required |
| Forge | Independent namespace port of LLVM typed CPU graph and cancellation tests, registered with CTest | Not enabled; scalar bootstrap admission only |
| .NET | Native AOT-safe `ExecutionGraphV1.cs`: typed checked CPU graph, externally admitted Task<T> futures and cancellation, explicit unsupported device/transfer nodes | Not enabled; scalar CIL source bootstrap only |
| Wasm | Keeps core Wasm zero-import environment and native LLVM source compiler gate | Not enabled; requires distinct capable host ABI, and no fake GPU execution |

Source compatibility resolution: `gpu { body }` is **proposed eager region**,
`gpu () { body }` and `gpu (typed args) { body }` are **proposed callable
kernels**. Java's compiler-only `ExecutionSurfaceV1` now recognizes those
forms and syntactic `nb` region nesting independently of normal
`Parser.parseProgram`, which intentionally continues to reject unlowered
execution. This avoids enabling the old ambiguous `gpu {}` callable spelling
in a real guest compiler without a migration review.

Host execution verification:
- The .NET, Java, and LLVM source *slices* are mirror-tested with exact original
  Git blob hashes on funded CI, using isolated harnesses. These runs are NOT
  proof that the complete Java Maven, .NET Native AOT or LLVM compiler trees
  pass, nor production GPU hardware tests.
- Forge has also been tested via an independently reconstructed **exact full
  Git source tree** on funded CI, with gcc/clang debug/release CTest.
- Java `ExecutionGraphChannelV1` wires one completed CPU value into a
  separately owned bounded Channel, with cancellation and backpressure. `nb`
  alone still does not invent an implicit stream.

Next executable gates: canonical source AST/typed effect inference, native
CPU region lowering through the real compiler, actor-owned continuation
scheduling, owned DOP HostBuffer/GpuBuffer transfer ABI, trusted GPU
OpenCL backend and physical hardware generation fences, and explicit
multi-batch streaming with bounded byte credits and failure propagation.

## Audited parity hardening (2026-10-16, second pass)

This section records **committed code**, not claims of complete source-language
execution. All five feature branches remain draft and unsupported domains
continue to fail closed.

- **Java**: `ExecutionGraphV1.Plan` now verifies full node signatures,
  dependencies, host/device value kinds, and output kind before execution.
  `ExecutionSurfaceV1` still only *recognizes* eager regions versus
  anonymous GPU callables; `Parser.parseProgram` still refuses general
  cpu/gpu/nb source lowering. `ExecutionGraphChannelV1` has one-value
  CPU-to-bounded-channel delivery, **not** an implicit Stream.
- **LLVM and Forge**: each native `Plan` constructor validates the complete
  typed graph before an unchecked node ID could reach its execution buffer.
  Registered dedicated CTest cases include malformed opcodes, forged IDs,
  forward edges, operand/domain mismatch, no-device fallback, and 20,000
  deterministic invalid graph inputs. This protects host IR admission; it
  does **not** implement GPU hardware dispatch.
- **.NET**: `ExecutionGraphV1.Plan` now independently validates every
  opcode signature, operand, graph/output index, and value kind before
  storing a defensive copy. Native AOT and entire .NET test suite still
  require current-branch execution.
- **Wasm**: delegated native LLVM compiler negative test now requires a
  domain-specific diagnostic, exact failed-exit behavior, zero IR stdout
  and no unexpected sidecar file; a valid scalar LLVM IR control remains.
  An absent compiler is a **skip**, not verified Wasm guest parity.
- The native validator has passed reconstructed local GCC Debug/Release
  and Clang ASan/UBSan checks (83 directed assertions and 20,000 malformed
  admissions). This is **not an exact GitHub PR-head test run**, and
  no Java full Maven, .NET Native AOT, LLVM whole-tree, Wasm real-compiler,
  or physical GPU release gate is certified.

**Private CI boundary**: The Java source repository's protected-branch
metadata currently reports unprotected main, the reviewed private source
export allowlist on main contains no approved destination, and an earlier
public-carrier disclosure remains open. Until those conditions are reviewed
and corrected, do not transfer any further private source Git blobs or
trees to another organization, even when a private carrier has Actions
minutes. Source-org workflow failures with missing runner IDs and no steps
are *infrastructure unknown*, not passing/failing source tests.

**Merge order**: (1) independently review native graph admission and
run exact-head tests on authorized runners; (2) reconcile Java checked DOP
region planner and owned CPU regions plus LLVM exclusive write loans;
(3) implement typed source AST/effect-to-graph CPU lowering; (4) make
`nb` actor-safe, cancellable and bounded without conflating Future and
Channel; (5) implement real GPU device allocation/transfer/fence dispatch,
with hardware evidence and no silent CPU fallback.

## 2026-10-16 executor and ownership race hardening

**Current source PR status:** these feature branches remain draft. Java,
LLVM, .NET and Forge now atomically claim a submitted one-shot CPU graph
task before evaluation. Duplicate executor dispatch cannot run the same
task twice. LLVM, Forge and .NET also revoke a queued-but-unstarted task
when the external executor throws an admission error after enqueue.

Java `ExecutionGraphV1.executeCpu()` now refuses synchronous execution
on an active actor carrier. Its asynchronously supplied CPU work also
checks the carrier context, detecting unsafe inline executors instead
of silently pinning an actor's execution lane.

.NET `Plan` now deep-freezes every caller-owned operand list before
typed admission; a shallow `Node[]` clone did not establish ownership
or prevent post-admission edge mutation. The verification harness now
contains a regression for mutable operand aliases, two-thread duplicate
dispatch and late executor rejection.

LLVM and Forge conformance tests include concurrent duplicate dispatch
and rejection-after-enqueue regressions alongside typed IR validation.
The local **reconstructed native header** passed GCC Debug/Release and
Clang ASan/UBSan for 83 directed assertions, 20,000 malformed IR
rejections, 1,024 duplicate-dispatch pairs and late executor rejection.
This local reproduction is **not** the exact committed branch head;
do not report it as complete CMake/compiler parity.

Wasm remains a capability-gated *delegate* of the real LLVM frontend.
It has no independent source-level graph evaluator, GPU driver or async
device stream. The host Future/Channel abstractions also remain distinct.

**Release/security gate:** Current source-repository Actions jobs failed
before a runner was assigned (`runner_id=null`, `steps=null`).
There is no verified full exact-head Java Maven, LLVM/Forge CTest,
.NET Native AOT, LLVM-to-Wasm or physical GPU CI pass on these new
commits. The private-source export allowlist on Java `main` remains
empty, `main` is reported unprotected, and the open P0 public-carrier
exposure incident must be contained. **Do not transfer more private
source to another organization solely to obtain Actions minutes.**

## Integrated-main and delegated-compiler parity gate (2026-10-16)

All five draft graph branches were checked against their latest available
`main`; Java, LLVM, .NET and Forge explicitly reconciled intervening
mainline commits, and Wasm required no mainline merge. The reconciliation
preserves Java actor runtime/AsyncNativeIo/performance files, LLVM
logging/CTest, Forge mailbox lifecycle/CTest, and .NET mailbox admission,
source lexer and test-runner behavior. **Git ancestry and blob preservation
are static merge evidence, not a successful compiler or runtime build.**

The Wasm delegated native frontend test requires
`ORESLANG_LLVM_COMPILER` to be an absolute path to a regular executable
file and `ORESLANG_LLVM_COMPILER_SHA256` to match its bytes. Compiler
identity must be verified independently by the build/release owner; a
self-supplied digest alone is not trusted provenance. No compiler means
the test is **SKIPPED**, never passing real Wasm source conformance.
Actual `cpu` / `gpu` source lowering and GPU hardware execution remain
unimplemented.

**Validation separation:**
- Each native graph plan must reject forged dependencies, invalid opcodes,
  incorrect host/device types and implicit GPU fallback before scheduling.
- Java/​LLVM/​Forge/​.NET host-graph Future tests must cover
  executor rejection after enqueue and duplicate delivery; Java also
  refuses synchronous graph execution on an actor carrier.
- For source-level capability, run a real compiler and positive scalar
  source fixture plus registered negative `.ores` cases with no output
  artifact. A host-only graph test does not satisfy a source compiler gate.
- Accept a GitHub Actions report only with exact candidate commit/tree,
  executed nonempty test steps, job-to-step binding, and correct run attempt.
  The shared evidence verifier is tracked separately in Java #1112,
  LLVM #495, .NET #56, Forge #50, Wasm #52; do not silently treat a
  source-free/mock verifier test as compilation proof.
- No private-source mirror is authorized solely by available Actions
  minutes. Require the protected-origin policy and reviewed destination
  allowlist before any cross-org transfer; current source-org zero-step
  failures do not prove passing or failing code tests.
