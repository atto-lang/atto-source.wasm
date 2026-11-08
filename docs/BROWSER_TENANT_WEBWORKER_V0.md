# Browser tenant / Wasm actor experiment (v0)

**Status: experimental browser host for trusted synthetic scalar guests only. NOT a production sandbox, NOT AttoLang compiler-backed actor parity, NOT Wasmtime.**

## Which compiler/runtime actually exists?

- `oreslang-source.wasm` currently bridges **native LLVM compiler -> LLVM IR -> Clang/LLD -> Wasm32** with Node.js scripts. Its experimental native Rust **Wasmtime AOT host** is under `aot-host`; its pooled actors use **Node worker_threads**, NOT browser Web Workers.
- `oreslang-source.rs` is an independent **Rust/Cranelift native object compiler** with NO Wasmtime dependency and NO browser Wasm target yet.
- `oreslang-source.js` transpiles Atto/Ores source subsets to **JavaScript/ESM**, and has trusted browser Web Worker / Node Worker reference hosts. It is not Wasm or full Atto actor lowering.
- `atto-lang/atto-source.rs` is the **different Rust source-to-Wasm compiler actually vendored by `atto-lang.github.io/play/`** as `atto_compiler.wasm`. That browser compiler emits a *second*, guest Wasm module. The public website's currently pinned receipt still declares `atto.browser.guest.v1`, while the Rust compiler upstream describes a newer v2 actor ABI. Those are not interchangeable without a reviewed release.

## Target browser architecture

```
Browser UI -> Rust compiler-as-Wasm Worker -> validated .atto guest Wasm32
  |-> tenant A: module Web Worker (trusted JS scheduler/admission/capability broker)
  |     |-> actor A1: WebAssembly.Instance + private 32-bit linear memory
  |     |-> actor A2: distinct WebAssembly.Instance + distinct memory/heap/stack
  |-> tenant B: different module Web Worker + its own actor instances
```

Reusing the same validated `WebAssembly.Module` for multiple **different `Instance` objects** is permitted: mutable globals and private memories belong to each instance. Merely carving several arenas out of **one instance's memory** does NOT enforce memory isolation against arbitrary Wasm code in that instance. Wasm32 pointers are **32-bit offsets** on both 32-bit and 64-bit host machines, but address-space width is not an allocation quota: require a strictly bounded page maximum and aggregate tenant/actor RSS, compiled-code, mailbox and CPU budgets. The browser engine's implicit Wasm call stack is not a separately allocated or quota-enforced actor stack; compiler-managed bounded frame/continuation arenas and trampolines/recursion quotas are still required.

## Browser-native reference host in this branch

- `src/browser-tenant-admission.mjs`: copies input into a private snapshot; checks independently supplied SHA-256, size, zero imports, no start/table/GC/shared/memory64 features, exact scalar actor lifecycle exports and signatures, and a **fixed private two-page Wasm32 memory** before compilation. Its hash is only byte identity, **not trusted compiler authentication** if supplied by the same attacker.
- `src/browser-tenant-worker.mjs`: a pure browser module Worker with **up to 16 separately instantiated scalar actor guests**, a bounded 64-message host lane, serial admission/turns across async verification, i64-only data values, and actor-local teardown+memory zeroing. A genuine synchronous `unreachable` trap may retire its actor after cleanup; any other trap or uncertain cleanup **poisons the entire tenant Worker**. It intentionally refuses untrusted pooling; there is no Wasmtime dependency.
- `tests/browser-tenant-worker.browser.mjs`: **opt-in, no-skip** real Clang + Chromium fixture: two same-tenant actors with distinct Wasm memory and independent mutable state, stop/reincarnation reset, healthy neighbor continuity. Clang/LLD emits an unused fixed function table in this fixture; the test-only helper removes exactly that unused table then runs WebAssembly validation. This **synthetic C-compiled Wasm is not Atto-compiled guest parity**. Any Chromium failure is NOT_EXECUTED/PENDING, not a pass. This test is deliberately outside default `npm test` until a browser-enabled runner is available.

**Important limitations:** the worker is an in-Worker execution component, not the parent supervisor. Production admission must authenticate compiler/source/ABI independently, queue/spawn commands by authenticated tenant and actor generation, meter total allocations, cap stdout and mailbox bytes, and use parent-owned deadlines, cancellation and termination receipts. A synchronous infinite loop monopolizes a Worker: **only its parent can terminate the Worker**, and termination loses *all* actors sharing that Worker. Logical actor-local stack overflow containment has **not** been proved; do not catch arbitrary engine stack exhaustion and pretend only one actor died. Browser Workers are not OS isolation domains for hostile mutually distrusting tenants.

## Required promotion gates

1. Independent review of exact compiler source tree, digest and guest v2 ABI; no v1/v2 receipt substitution. Real `.atto -> compiler-as-Wasm -> guest Wasm32 -> actual browser` actor source tests must run and verify multiple actors and their state.
2. Parent-owned tenant supervisor: opaque generation-fenced ActorRefs, admission/dispatch authentication, FIFO per actor, bounded queue bytes, fair scheduling, cancellation/join/close, physical `Worker.terminate()` barrier, and stale ticket rejection.
3. Source-level bounded actor stacks/frames/continuations/ownership and per-actor heap arenas, zero-GC guest semantics, no callable data crossing Worker boundaries, and cooperative yield or deterministic instruction budgets.
4. Negative tests for imported functions, table/start/GC/memory64/shared memory, forged replies, replay, cross-tenant messaging, memory pressure, loops, stack overflow, failed retirement and hot generation changes.
5. Independent nonzero-step **exact-head** Chromium, native Wasmtime and LLVM/Atto guest differential receipts. Host-only simulation is separate evidence. `steps=[]` remains **NOT_EXECUTED**.

See `docs/WASMTIME_TENANT_STORES_V0.md`, `docs/POOLED_WASM_ACTORS_V0.md`, and the browser playground's `play/docs/BACKEND_MAP.md`.