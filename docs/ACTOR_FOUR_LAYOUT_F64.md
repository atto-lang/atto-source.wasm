# Actor-owned four-layout f64 substrate

This host-only module builds dense f64 data-oriented storage directly on the hardened actor-owned `WebAssembly.Memory` arena.

Supported physical layouts are **AoS**, **SoA**, tiled **AoSoA**, and grouped **SoAoS**. SoAoS is a structure of arrays of compact structures: field groups occupy separate contiguous spans, and each span stores row subrecords. It is not an alias for tiled AoSoA.

The store owns exactly one persistent arena allocation. Checked relative reads/writes copy through bounded host buffers; no raw `WebAssembly.Memory` view, byte offset, or opaque arena handle escapes. SharedArrayBuffer inputs/destinations are rejected by the arena range API.

This remains a host/runtime substrate. It does not yet prove source `inverted class`, ECS, actor, SIMD, wasm32 codegen, or Wasmtime AOT parity. The 64 KiB shard cap follows the current experimental actor persistent-page size rather than defining the future Oreslang ABI.
