# Shared reactor workers and SoA metadata — proposed v2

Status: opt-in host-runtime experiment. Not a replacement for the current
NIO_ACTOR_EXECUTION_V1 contract, not a compiler/guest parity certification,
and not an automatic change to existing runtime or CLI defaults.

## Target behavior

A capable backend's shared profile starts two Oreslang-owned workers in one
trusted execution domain. Both can execute admitted bounded slices and hold
the reactor polling role. Exactly one worker owns that role at a time. One
worker mode is supported; an explicit supervisor may provision up to the
configured maximum (1..256). Actor creation, socket count and pending awaits
do not provision workers. No separate selector/completion/bootstrap thread is
created by these host components.

A worker runs at most 64 bounded slices before attempting an I/O poll. With
no ready work the poll may wait at most 10ms; otherwise it must be nonblocking.
The reactor publishes host records through the bounded ready queue, never
invoking source callbacks on its polling stack. Resumed source work still
requires the owning scheduler/actor execution lease and a fresh dispatch id.
A producer publishes before signaling both scheduler and reactor. Reactor
wakeups must be nonblocking, thread-safe and sticky across poll entry.

Ready admission is bounded at 1024 entries. Rejection leaves ownership with
the producer; a reactor must retain/retry a completion rather than drop it.
Close seals admission, drains accepted ready entries and joins all workers.
Self-join is rejected before mutation. The embedding must first fence new I/O
and retire/drain reactor registrations while worker admission is still open;
joining workers alone does not prove kernel-operation or actor-heap retirement.
The externally owned reactor and all callback arguments outlive close/join.

## Data layout and performance

Use separate columns for cold OS thread handles, worker states and completed
counters. The native ready ring also separates function and argument columns.
Hot per-worker writes use cache-line strides (64 bytes in these experiments);
Java/.NET strides reduce sharing but do not guarantee object alignment.
Keep atomics and acquire/release publication rules; SoA is not synchronization.

Do not assume densely packed SoA is fastest. Adjacent workers updating adjacent
counters can false-share a line. The native counter benchmark compares equal
logical fields in AoS, dense SoA and padded SoA at 1..4 writers, using five
samples and reporting medians. It is not an end-to-end scheduler benchmark.
Before production default changes measure task throughput, p50/p99 wake
latency, idle CPU, allocation rate, memory cost and cache contention on
representative hardware. Do not enforce noisy speed ratios as CI correctness
assertions.

## Backend integration status

| Backend | This slice | Remaining integration |
| --- | --- | --- |
| Java | Opt-in SharedReactorPool; real Selector/Pipe host checks; JUnit wrapper | Reconcile with draft VM NIO integration; actor/CONTROL authority, isolate entry and bootstrap retirement |
| LLVM | Opt-in C++ SharedReactorPool; Linux FD readiness host checks | Existing native scheduler/reactor bridge and compiled continuation wiring |
| Forge | Same native pool and test bytes as LLVM | Source actor lowering and trusted reactor adapter |
| .NET | Opt-in SharedReactorPool plus UDP readiness host checks | SDK10 execution, production completion backend, source actor/Native AOT wiring |
| WASM | Explicit denial of shared worker requests before guest decoding | Versioned host I/O and source actor/continuation capability; host event loop is not an Oreslang thread |

The experimental pools schedule trusted host slices in one domain. They do not
replace actor mailbox authority, cancellation/generation fencing, reserved
CONTROL progress, or untrusted-isolate boundaries. Never mix incompatible
domains merely to reach a two-thread total. Existing additional VM, GC, JIT,
FFI, cleanup, user-owned scheduler and process-isolation threads are reported
separately; these components cannot promise two threads for the whole process.

## Required evidence

- 1/2-worker startup and explicit growth cap; pending I/O does not grow workers.
- Single polling owner, real readiness, no callbacks on the polling stack.
- Same OS workers observed in both polling and execution roles.
- Runnable queue remains hot while readiness completion still makes progress.
- Queue saturation, concurrent producers, exactly-once accepted-work accounting.
- Ordinary handler failure containment, self-join denial, graceful drain.
- Completion/cancel/close and kernel retirement tests in the actual backend bridge.
- Compiler-backed shared .ores fixtures before any source-language parity claim.
- Fixed, prestarted resources and separate RT admission for a real-time profile.

Any eventual CLI flags must go through flags-2-env. These host constructors do
not introduce or enable CLI flags. Hard-real-time admission is not implemented.
