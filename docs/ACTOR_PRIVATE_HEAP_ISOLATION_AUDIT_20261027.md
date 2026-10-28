# Actor-private heap isolation audit — 2026-10-27

Status: DRAFT. No backend is certified end-to-end by this audit.

## Required meaning of isolation

Every actor, including a SHARED actor, owns private mutable guest memory.
SHARED describes dispatch/explicit shared-domain eligibility, never implicit heap
aliasing. ActorRef grants message admission, not heap access. Copy/checked move
must cross the mailbox; raw arena handles, scratch tokens and native pointers
must not be serialized or forwarded as authority.

A private arena is a checked ownership boundary, not an OS address space or a
sandbox against arbitrary native/FFI/CLR/JVM code. A stronger untrusted execution
request must fail closed without an independently certified isolate/worker/process
adapter. No OS thread per actor is required: carrier pools schedule physical turns.

## Current-source audit matrix

| Backend | Inspected source | Finding / required integration |
|---|---|---|
| Java/GraalVM | main commit 5c9e30174bb4ceec93c5dadbffd1b90b6f3b9aef; native-storage PR #2012 commit 560e0a207f293a65df0a9982886bfdf062dd6e51 | main lacks ActorNativeArena/ActorLinearMemory. #2012 is host storage, not ActorRuntime or all guest allocation lowering. Cleanup callback failure made close nonretryable; this audit patches it. JVM facades/metadata remain managed. |
| LLVM | main commit 6d48e2dbf0179826968447ed328bdf7d481a751e; ActorArena.c blob 4124c2ce80a8d130ce3b86f93fa0849ccbcdb6c7 | Native arenas fence owner/incarnation/turn/carrier/loan. Optimized pre-free memset loses physical scrubbing; this audit adds volatile writes. Native C ABI alone does not certify every guest allocation or external callback join. Reconcile existing #840/#845/#846/#891, not silently replace them. |
| WASM | main commit 76426512305e07464032710034bcf1a0a9449166; PR #148 commit cf7767de844b5fa36b442171313a38e0e18c2745 | Host-only per-arena WebAssembly.Memory. #148 transactional/intrinsic fixes remain draft; this audit removes inherited negative-index release lookup. Guest module imports, scheduler integration, worker isolation and deterministic physical memory reuse remain separate gates. JS GC controls current backing release. |
| .NET | main commit 30e7742503f857372bd96f12e858bd71c4a2fdb6; ActorArena.cs blob fb6adda96671148eccba15b83582949f14b5fe4a | Unmanaged host arena exists; main has no ActorRuntime/ActorContext integration files. Exact-issued capabilities, serial cells, aggregate budget and scratch improvements are on separate #110/#111/#112/#129 lines. Do not claim guest lowering, per-actor CLR heaps, NativeAOT or untrusted sandbox parity. |
| Forge | main commit e0513d495f0b0b30bd6999f402b4dec2f2f1f4b4; runtime/actor.hpp | Main actor substrate is bounded authenticated mailbox, without actor arena implementation. Integration #58 (ebf9e76c34f2ee367749388abc1f5351de5311cc) remains open; #85 closed does not establish its presence in main. Port/reconcile runtime candidate before claiming any source actor heap parity. |

All five mains have identical lifecycle/quiescence contract blobs. That proves
contract text parity only. It cannot substitute for runtime or compiler evidence.

## Corrections and executed evidence

* Java: keep logical revocation sticky; track native-free progress independently
  from budget-refund completion, retry callbacks without double free/refund.
  Refund contract: a thrown callback has no committed accounting side effects.
  Guard recursive cleanup. Add three regression methods and require all 11
  standalone methods in the existing exact-head receipt workflow.
* Java local: OpenJDK 17 compiler module, actual production storage classes and
  real JNI C, real test method bodies using a minimal assertion/loader compatibility
  harness (NOT the project's JUnit runner). Baseline fails with 4192 charged bytes
  after failed close; patched 11/11 pass. Same patched bodies pass with JNI UBSan.
  Actual Maven/JDK25/GraalVM Native Image is NOT_EXECUTED.
* LLVM local: strict GCC C11/C++20 -O2 native actor test passes (13 expected-abort
  misuse cases, 8192 slot reuse cycles, carrier migration, loans and retirement).
  New GNU linker --wrap calloc/free regression observes backing and metadata
  immediately BEFORE free: original -O2 source FAILS, volatile-scrub patch PASSES.
  Both patched focused executables pass ASan+UBSan, detect_leaks=0.
  No full compiler build, Clang result, LSan, hard-RT WCET or guest AOT proof.
* WASM local: Node 24.22.1, 23/23 focused tests pass, zero skips/failures. New
  inherited "-1" getter regression fails on #148 baseline and passes patched;
  validates reuse zeroing, a live neighbor sentinel and stale-handle rejection.
  Not Wasmtime AOT, browser worker or guest source execution.
* .NET and Forge: runtime tests NOT_EXECUTED in this audit; no implementation
  changes claimed for these two backends.

## Mandatory end-to-end acceptance gates (all five remain pending)

1. Compile real source actors, allocate every supported guest aggregate through
   actor storage, deny foreign-owner/forged/stale/generation/turn handles.
2. Two actors use equal logical offsets with independent values; direct field,
   closure, static/global, task-result, mailbox and FFI paths cannot leak mutable
   private storage. Shared regions require explicit grants, rights and lifetimes.
3. Compiler rejects scratch/borrow escape across await/select/cooperate/FFI;
   persistent values survive carrier migration with authenticated resume tickets.
4. Bounded per-actor plus runtime/process quotas; failure-neutral admission;
   identity exhaustion cannot wrap; drop exactly once on every exit.
5. STOP/cancel/fault closes admission first. Reclaim waits for physical turns,
   tasks, read loans, FFI/I/O callbacks and shared-domain pins. Observer completion
   does not certify upstream owner retirement.
6. Cleanup failure leaves authority revoked and dirty capacity unpublished;
   retry preserves progress. Scrub backing and authority metadata before reuse/free.
7. Prove boundary-specific untrusted isolation or reject it. Native arbitrary
   pointer access, CLR AssemblyLoadContext and a Truffle Context alone must not
   be advertised as separate protected actor address spaces.
8. Run exact-head guest compiler + host lifecycle + native/AOT tests, record commit,
   tree, input blobs and executed non-skipped assertions. Zero-step CI is
   NOT_EXECUTED. Cross-org private source transfer is outside this audit.

## Integration order

Execute and review Java #2012 storage fix, wire it into actual actor spawn/turn/
suspension/physical-finalization, then close guest allocation escape paths.
Reconcile native LLVM runtime drafts and execute real guest actors.
Bring WASM's current-main allocator fixes forward, attach restricted module imports
and generation-owned scheduling without exporting memory.
Reconcile .NET serial runtime/capability/budget branches and run .NET 10 NativeAOT.
Reconcile Forge's host arena integration onto main, execute host tests, then add
source lowering. Run the same end-to-end vectors on each resulting exact head.
