# Actor-private mixed-width storage in WebAssembly.Memory

Status: **host-runtime data substrate**, not emitted wasm32 guest code or source-compiled Oreslang actors.

`ActorMixedShard` uses the checked `MixedLayoutGeometry` and creates one persistent, actor-owned allocation through `ActorArena`. It addresses `u32`, `f64`, `bool` and **non-dereferenceable** encoded `ref32` fields with little-endian primitive reads/writes. Four independent physical layouts are supported: AoS, SoA, AoSoA and grouped SoAoS, matching LLVM DOP heterogeneous planner draft #837 and shared parity ABI draft #145.

The current actor arena leases disjoint pages in bounded, runtime-owned `WebAssembly.Memory`; this is *logical per-actor region isolation*, not a separate Wasm instance/memory for each actor and not OS security isolation. Actor runtime validates the admitted turn, private handle identity, range and generation before byte access. No source-level linear-memory capability or raw mutable view is exported. The shard's staging buffer remains private; release zeroes it and drops/scrubs the underlying persistent arena allocation.

Source ABI golden example: id:u32, x:f64, flag:bool, next:ref32; AoS 72 bytes, SoA 56 bytes physically (51 field payload, aligned segment bases), AoSoA width four and five live rows 144 bytes, SoAoS grouped [[id,flag],[x,next]] 72 bytes. The shard caps its *actual physical allocation* to 64 KiB; larger actor quota policies are separate.

Real guest source-level allocations, typed HIR/MIR, ownership-aware writer/reader loans, stable generation-checked ECS row handles, source compiler lowering, Wasmtime/browser execution and cross-backend certification are still missing. These tests are host Node checks with an actor-owned WebAssembly.Memory substrate; no actual Wasm module instruction sequence is claimed. The new feature branch is stacked on Wasm four-layout PR #112.
