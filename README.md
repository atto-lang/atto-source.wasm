# Oreslang WebAssembly compiler backend

This repository is the dedicated **Oreslang source-to-WebAssembly backend**.

## Status

Bootstrap in progress. The existing `oreslang-wasm` repository contains an experimental LLVM-to-core-Wasm bridge and runtime ABI prototype; this repository will own the compiler integration and fail-closed guest admission/isolation host. Neither that bridge nor this new repository currently implements full Oreslang actors or production-grade OS sandboxing.

Design goals:
- Compile trusted Oreslang LLVM IR to core `wasm32` with an explicit, pinned compiler binary.
- Reject undeclared host imports, unbounded/shared memory, malformed entries, and start sections.
- Execute guests in separate disposable workers with deadlines and zero host capabilities for the initial scalar profile.
- Maintain evidence-backed testing; stub compiler tests never count as Oreslang compiler parity.
- Eventually support typed actor messaging, ownership-safe memory, WIT and WASI capability profiles.

This bootstrap README establishes the main branch; development continues in a reviewable PR.
