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
- `src/browser-tenant-supervisor.mjs`: **parent-owned** per-tenant Worker lifecycle with a copied, build-time-pinned manifest (max 8 MiB total), opaque `WeakMap` ActorRef capabilities, randomized 128-bit incarnation fencing, monotonic tickets, strict response binding and a bounded pending lane. Invalid artifact names cannot be supplied as arbitrary actor bytes from the caller; the Worker independently hashes and checks the approved snapshot. One supervisor instance owns exactly one Worker; multiple supervisors represent multiple separate Workers. The deadline and unexpected/forged reply paths quarantine the **whole tenant**, request physical `Worker.terminate()`, and reject all outstanding operations. **No browser API confirms actual termination completion.** This does not authenticate an application-supplied manifest: only reviewed, trusted same-origin application code may create a supervisor.
- `src/browser-tenant-supervisor.test.mjs`: default dependency-free Node parent-protocol unit tests for stale/forged refs, cross-tenant denial, replay, bounded queue, deadlines and artifact snapshot integrity. **Mock Worker only**; not a guest execution receipt.
- `tests/browser-tenant-node-smoke.mjs`: explicit opt-in `npm run test:browser-tenant-node` (requires local Clang, wasm-ld, Node >=22). Runs **real compiled wasm32** in the actual browser Worker module through a Node test adapter, verifies actor A/B state isolation, actor-local unreachable fault, independent tenant and forged digest rejection. **Synthetic C source**, NOT compiler-backed AttoLang or Chromium parity.
- `tests/browser-tenant-worker.browser.mjs`: **opt-in, no-skip** real Clang + Chromium fixture: the raw Worker protocol plus the **real parent supervisor**: two same-tenant actors with distinct Wasm memory, a third actor in a separate tenant Worker, independent mutable state, cross-tenant capability rejection, actor-local unreachable fault containment, stop/reincarnation reset and healthy-neighbor continuity. Clang/LLD emits an unused fixed function table in this fixture; the test-only helper removes exactly that unused table then runs WebAssembly validation. This **synthetic C-compiled Wasm is not Atto-compiled guest parity**. Any Chromium failure is NOT_EXECUTED/PENDING, not a pass. This test is deliberately outside default `npm test` until a browser-enabled runner is available.

**Important limitations:** the worker is an in-Worker execution component, not the parent supervisor. Production admission must authenticate compiler/source/ABI independently, queue/spawn commands by authenticated tenant and actor generation, meter total allocations, cap stdout and mailbox bytes, and use parent-owned deadlines, cancellation and termination receipts. A synchronous infinite loop monopolizes a Worker: **only its parent can terminate the Worker**, and termination loses *all* actors sharing that Worker. Logical actor-local stack overflow containment has **not** been proved; do not catch arbitrary engine stack exhaustion and pretend only one actor died. Browser Workers are not OS isolation domains for hostile mutually distrusting tenants.

## Rust compiler `.atto` actor ABI adapter (staged, source-only)

The existing import-free `oreslang_wasm_actor_* / fixed-two-page` protocol and the
Rust playground's integrated guest ABI **are different contracts**. Do not
silently reinterpret scalar-bytecode as compiler-produced AttoLang actors.

The new `src/browser-atto-actor-admission.mjs` checks the Rust
`atto-lang/atto-source.rs` emitted contract against actual Wasm function-type
sections, import signatures, optional private memory, global exports and
named actor receivers:

- Exact `main(): i64`, `panic_code` global index zero,
  `atto_actor_receive_<id>(i64): i64`, and optional exported fixed-max
  `memory` (at most **16 × 64 KiB Wasm32 pages**).
- Only `atto` function imports with exactly verified scalar signatures:
  `print_i64`, `print_bool`, `print_str`, `print_newline`,
  `actor_spawn`, `actor_send`, `actor_join`.
- Imported memories, tables, start/element sections, shared or memory64,
  managed GC/reference types, SIMD/threads and unsupported instruction
  extensions are rejected. This profile opts into the existing no-managed-Wasm
  *instruction* scanner **only after** validating every function import.
- `src/browser-atto-tenant-worker.mjs` instantiates the approved guest **once
  per actor** under a single tenant module Worker. It NEVER calls `main()`;
  all nested actor and stdio imports are explicitly denied in actor receives.
  Each `Instance` has private mutable globals and, **when the compiler emits
  linear memory**, a private bounded heap. Absence of a memory section is
  legitimate for scalar-only actors; do not pretend it proves an arena/stack.
- The parent `BrowserTenantSupervisor` pins
  `profile='atto.browser.actor.integrated.v1'` and `actorId` in its trusted
  artifact manifest. The actor's request cannot choose an arbitrary handler.
  Wrong profile/identity fails closed; legacy scalar workers remain unchanged.

**Still missing:** compiler-proven logical stack/continuation limits,
preemptive CPU quotas, browser OS sandboxing, and a complete typed actor API.
One busy synchronous actor can monopolize its tenant Worker, so the parent
supervisor quarantines that **whole tenant** on deadline. No browser
`Worker.terminate()` OS completion receipt exists.

### Source-free and real compiler gates

`npm test` includes ABI-section negative tests using an **independently
hand-encoded synthetic Wasm guest** with two `atto_actor_receive_*` exports,
private mutable state, an import that must not be called, and real V8 Wasm
execution. More expensive opt-in gates:

```sh
npm run test:browser-atto-tenant-node   # real Node Workers, synthetic integrated ABI guest
npm run test:browser-tenant            # real Chromium via CDP, both Wasm ABI profiles
```

For an **actual `.atto` source compilation proof**, provide an independently
reviewed Rust compiler-as-Wasm artifact on a secure, authorized machine; the
repository will NOT download/mirror/release it automatically:

```sh
export ATTO_COMPILER_WASM=/approved/atto_compiler.wasm
export ATTO_COMPILER_SHA256=<independently-approved-64-char-lowercase-digest>
export ATTO_COMPILER_SOURCE_HEAD=<reviewed-40-char-commit-sha>
export ATTO_COMPILER_SOURCE_TREE=<reviewed-40-char-tree-sha>
npm run test:browser-atto-compiler-node
npm run test:browser-atto-compiler-chromium
```

The real-compiler Node gate uses compiler ABI 2, compiles two source-level
actors, then runs separate actor instances in one tenant Worker alongside an
independent tenant Worker. The **Chromium gate recompiles the same `.atto`
source inside the real browser compiler-as-Wasm**, compares the generated
guest SHA-256 with independently generated Node output, and executes two
actors in one tenant Worker. Both enforce stale-capability and neighboring
actor/tenant continuity. An absent approved artifact is a **hard test
failure**, never a silent skip. Binary digest plus manually supplied head/tree
values are not self-authenticating provenance; CI/release reviewers must
independently verify the source tree and build before counting receipts.

**Evidence status at authoring:** staged code and synthetic local checks only;
the real-compiler Node/Chromium integration gates have **not executed** on
an approved compiler binary, and source repository CI has encountered
zero-step runner admission failures. Keep the draft and the public playground
release hold; do not change the `/play/` pinned compiler receipt or publish
private compiler artifacts merely to run these tests.

## Running the gates

```sh
npm test                         # includes parent protocol mock tests
npm run test:browser-tenant-node # requires Clang/wasm-ld; actual Node Workers + guest Wasm
npm run test:browser-tenant      # requires Clang/wasm-ld + Chromium; real browser Workers
```

None of these tests demonstrates source-compiled `.atto` actors until the independently reviewed Rust browser compiler's actor ABI is wired into the verified runtime. The public site currently pins an older compiler/guest ABI; never substitute a newer binary, change release receipts, or publish private compiler artifacts without the separate approval and provenance process.

## Required promotion gates

1. Independent review of exact compiler source tree, digest and guest v2 ABI; no v1/v2 receipt substitution. Real `.atto -> compiler-as-Wasm -> guest Wasm32 -> actual browser` actor source tests must run and verify multiple actors and their state.
2. Parent-owned tenant supervisor: opaque generation-fenced ActorRefs, admission/dispatch authentication, FIFO per actor, bounded queue bytes, fair scheduling, cancellation/join/close, physical `Worker.terminate()` barrier, and stale ticket rejection.
3. Source-level bounded actor stacks/frames/continuations/ownership and per-actor heap arenas, zero-GC guest semantics, no callable data crossing Worker boundaries, and cooperative yield or deterministic instruction budgets.
4. Negative tests for imported functions, table/start/GC/memory64/shared memory, forged replies, replay, cross-tenant messaging, memory pressure, loops, stack overflow, failed retirement and hot generation changes.
5. Independent nonzero-step **exact-head** Chromium, native Wasmtime and LLVM/Atto guest differential receipts. Host-only simulation is separate evidence. `steps=[]` remains **NOT_EXECUTED**.

See `docs/WASMTIME_TENANT_STORES_V0.md`, `docs/POOLED_WASM_ACTORS_V0.md`, and the browser playground's `play/docs/BACKEND_MAP.md`.