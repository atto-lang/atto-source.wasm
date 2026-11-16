# Oreslang CPU/GPU expression and nonblocking execution contract — v1 (PROPOSED)

**Status (2026-10-16): normative target, NOT executable five-backend parity.** The Java/Graal frontend has a merged conservative execution-domain rejection gate (PR #700); the LLVM native gate is under review (PR #229). .NET and Forge are scalar bootstraps; the Wasm source backend delegates source compilation to an exact pinned LLVM compiler. Do not infer device execution, nested lowering, or streaming support from reservation, parsers, host-side DOP kernels, or this document.

## Decision

- `cpu { ... }` and `gpu { ... }` are **typed single-completion expression regions**, not collections of independently delivered stream messages.
- `nb cpu { ... }` and `nb gpu { ... }` return **Future<T>** (one completion or one failure, including Future<void>). `nb` means *nonblocking submission*, not multi-item streaming.
- Without `nb`, a region yields **T** if it produces a typed tail expression; a suspension-capable caller waits by parking its *logical continuation*, never its actor carrier/OS worker. A pending asynchronous region in a non-suspending routine must fail typing; no hidden thread blocking.
- A block with no value tail has result `void`, not a fabricated `Unit`, `Option<T>`, channel, stream, or promise. `const foo = gpu { ... }` requires a valid non-void result; a void block can only be used as a statement. A bare empty `gpu {}` is rejected until a meaningful device launch/effect is specified.
- `nb` does not imply parallel execution: resource admission, dependence, fairness and backend capability determine scheduling. CPU execution stays on admitted host OresVM carriers, never spawns a thread for every region.

Target grammar (parser support must be measured separately):

~~~ebnf
DomainExpr  = ["nb"] ("cpu" | "gpu") Block;
BlockResult = FinalExpression | void;
~~~

The region's **logical** result type T remains distinct from the **physical** residency of buffers. `HostBuffer<T>` and `GpuBuffer<T>` are different ownership-bearing types; a device value is not silently a host value. A GPU scalar usable on the CPU needs an explicit reduction/readback boundary.

## Nesting is a typed command graph, NOT an in-kernel host callback

| Lexical region | Lowering requirement |
| --- | --- |
| cpu -> cpu | Host continuation; may fuse subject to ownership/effects |
| cpu -> gpu | Validate/submit device command, establish fence, suspend or return Future |
| gpu -> gpu | Separate ordered device commands (or proved-safe fusion), never assume device dynamic parallelism |
| gpu -> cpu | Split device command at a legal boundary, await completion/fence, resume host continuation |
| gpu -> cpu -> gpu | Device fence -> host continuation -> validated new device launch, with explicit data transfers as needed |
| nb gpu -> nb cpu | A graph of two one-shot futures; distinct result/failure states; no implicit channel |

Nested blocks are **scheduler/compiler graph regions**. An outer `gpu` block can contain a syntactic `cpu` stage, but that stage runs on a host continuation AFTER the relevant device fence, not once per GPU thread. Device code cannot directly call a CPU routine, access an actor's host heap, block on a host Future, or run arbitrary callbacks. There is no automatic CPU execution when a GPU is absent.

Do not accidentally execute a CPU stage once per SIMT lane. The graph compiler must distinguish the lexical region from each device kernel's per-work-item body, require declared launch extent and memory effects, and reject ambiguous scalar output/lane-to-host reductions.

## Examples — illustrative only (not current accepted source)

Unary GPU work, explicitly yielding a device-resident result:

~~~ores
pub suspends routine transform(input: HostBuffer<f32>): HostBuffer<f32> {
    const device = await Gpu.upload(input);
    const submitted = nb gpu {
        transform_kernel(device)  // typed GpuBuffer<f32> tail value
    };                                   // Future<GpuBuffer<f32>>
    const output = await submitted;       // GpuBuffer<f32>
    return await Gpu.download(output);
}
~~~

Nested placement, explicitly staging the host/device transition:

~~~ores
pub suspends routine nested(input: GpuBuffer<f32>): GpuBuffer<f32> {
    return gpu {
        const stage1 = kernel_a(input);      // GpuBuffer<f32>
        const host = cpu {
            await Gpu.download(stage1);     // HostBuffer<f32>
        };
        const stage2 = await Gpu.upload(host);
        kernel_b(stage2)                    // typed tail expression
    };
}
~~~

The compiler must lower these to an ordered graph and preserve continuation ownership. The exact callable names, domain-expression grammar, and implicit/explicit await spelling remain an implementation target; do not treat these code fences as passing tests.

No-value distinction:

~~~ores
cpu { log_metric(); }                      // void host effect (if permitted)
const done = nb cpu { log_metric(); };     // Future<void>
gpu { kernel_write(output); }              // void GPU effect, valid after lowering
const done2 = nb gpu { kernel_write(output); }; // Future<void>
const invalid = gpu {};                    // reject: empty device region, no typed value
~~~

## Owned-by-value parameters: implicit move (no redundant rt take)

For an owned/move-only value, **passing it by value to a consuming parameter already transfers ownership** in the current Java Oreslang semantics. Therefore the canonical GPU pipeline examples use `Gpu.upload(input)`, `transform_kernel(device)`, and `Gpu.download(result)` without `rt take`. These operations are specified to consume their buffer argument; using the moved source afterward must fail type checking. See Java `FunctionArityOwnershipTest` and `MovedLetReinitializationTest`.

This is **not** a blanket rule that every call consumes every argument. A declared borrowing parameter uses a loan and keeps the owner usable after the loan ends; copy/share have separate effects and safety requirements. Explicit `rt take` remains useful for intentionally selecting a destructive move in an ambiguous context, not as mandatory boilerplate on consuming calls. The future GPU API must encode parameter modes in its typed signature and enforce ownership across each launch, transfer, cancellation and actor boundary.

## Streaming is orthogonal

A Future<T> is **one completion**. A `Channel<T>` or `Stream<T>` is **zero to many items plus close/error**, with bounded credits and lifetime rules. Merely writing `nb gpu` must never create a Channel or `GpuStream`. Device GPU command queues/streams are hardware execution scheduling resources, not Oreslang user-level output streams.

To stream work, create an explicit bounded host-owned producer/consumer edge: receive a HostBuffer batch, upload (explicitly), `await nb gpu` to produce one GpuBuffer batch, download (explicitly), publish one typed item to a bounded channel, and repeat. Backpressure must park host continuations; GPU kernels cannot directly send actor messages or user Channel events. Cancelled streams still retain device buffer leases until true fence/quiescence. There is no unbounded implicit accumulation of work items.

## Compiler and runtime obligations before enabling any positive case

1. AST + typed IR preserve region boundaries, Future<T>, effect rows (Host, Device, Transfer, Suspend), lexical tail type, errors, device launch extent, and typed DOP field/region dependencies.
2. Device kernels permit only proven GPU-safe calls, bounded operations and launch shapes; reject host IO, actor-state mutation, locks, reflection, dynamic host memory and unsafe borrowing. No CPU fallback.
3. Upload/download/peer migration are explicit operations; no hidden transfer through captures or a region's return. AoS/SoA/AoSoA, shape, widths, alignment, row/field ranges and alias/ownership proof must match exactly.
4. Every command has immutable tenant/device/capability/allocation-generation provenance, bounded admission, dependency fence and a single terminal event. Old device completions cannot revive retired handles. No mutable loan may overlap an in-flight kernel.
5. Errors are typed; `trap await future` can obtain a Result according to the existing exception/effect contract. Cancellation is a request, not proof a GPU stopped. Cleanup/free/restart must wait for device quiescence.
6. A nested host continuation respects serial actor turns and critical gates; it cannot resume actor state on two carriers simultaneously or block a carrier while waiting.
7. Negative admission tests and exact-source positive controls MUST run with each backend's real compiler. Prove CPU IR and actual GPU dispatch separately. A Wasm bridge result inherits the pinned LLVM compiler's language support and still needs compatible device capability.
8. Until all prerequisites exist, a backend emits a **specific unsupported-execution-region diagnostic** and no executable artifact. Do not mark source compatibility or GPU parity based on rejection-only tests.

## Backend checkpoints

| Backend | Current bounded statement | Unlock condition |
| --- | --- | --- |
| Java | Conservative reservation/rejection merged in #700; CPU DOP scheduler work in #1066/#1086 | Typed AST graph + executable kernels/fences + source tests |
| LLVM | #229 reserves/rejects nested scopes (unmerged); DOP host/kernel preflight separate | Native typed graph/futures and real GPU provider |
| .NET | Arithmetic/structured frontend bootstrap; reject cpu/gpu/nb | Typed compiler/effect IR and .NET AOT host/device adapter |
| Forge | Arithmetic/C++ compiler bootstrap; reject cpu/gpu/nb | Typed compiler/effect IR and host/device adapter |
| Wasm | Source compilation via pinned LLVM; import-free core guest ABI | Real source compiler support AND declared host/device capabilities; no magical WebGPU imports |

**References:** Java `docs/GPU_CPU_EXECUTION_DOMAINS.md`, LLVM `docs/ACCELERATOR_DOP_ACTOR_PIPELINE.md`, Java `docs/ACTOR_UNARY_STREAM_TRANSPORT_API_V1.md`. CPU/GPU syntax is independent of actor UNARY/STREAM reply roles.
