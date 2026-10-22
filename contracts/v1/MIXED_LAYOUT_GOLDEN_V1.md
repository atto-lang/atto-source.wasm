# Mixed-width layout golden vectors v1

Scope: runtime-host storage conformance only. These vectors do not attest source parsing, ownership lowering, guest execution, Worker/browser isolation or universal backend parity.

The byte-identical `mixed-layout-golden-v1.json` is consumed by JS Worker storage, Wasm actor-arena storage and the .NET unmanaged actor-shard tests. Changes to the versioned vectors must be reconciled across all three consumers.

The schema is `id:u32, x:f64, flag:bool, next:ref32`. All scalar encodings are little-endian. `ref32` is an unsigned encoded word, never a dereference capability.

| Layout | Rows | Payload bytes | Physical bytes |
| --- | ---: | ---: | ---: |
| AoS | 3 | 72 | 72 |
| SoA | 3 | 51 | 56 |
| AoSoA, tile width 4 | 5 | 144 | 144 |
| SoAoS, groups id/flag and x/next | 3 | 72 | 72 |

Payload bytes here follow the existing geometry API: segment bytes including record/tile padding, but excluding inter-segment alignment. Physical bytes include all padding and masked tail lanes.

Tests check exact offsets, zero initialization, uint32/ref32 maxima, bool values, signed zero, NaN and infinities, nonpositive row rejection, row/field bounds without mutation, and stale access after release. Empty geometry calculations remain permitted; an actor-owned store requires nonzero storage. Platform allocation caps remain intentionally different.

JS/Wasm command: `node --test tests/mixed-layout-portable-v1.test.mjs`. The Wasm host test uses real `WebAssembly.Memory`; it does not execute a compiled wasm guest. The .NET consumer is called from `ActorMixedShardSelfTest.Run()` in the existing verification harness. A present consumer is not an executed test result; exact-head Node/.NET and browser/source-generated execution have separate evidence requirements.
