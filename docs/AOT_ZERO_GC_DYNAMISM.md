# WASM — controlled dynamism for AOT and zero guest-GC

**Design directive / TARGET; not a passing backend receipt.** Companion to [organization policy PR #38](https://github.com/ores-truffle-oreslang/.github/pull/38) and [canonical language-spec PR #18](https://github.com/ores-truffle-oreslang/attolang-language-spec.md/pull/18). Also follow [AGENTS.md](../AGENTS.md).

## Required design constraints

- **Execution mode:** interpreter/JIT, hybrid, host-only AOT, sealed full guest AOT, or governed precompiled-module AOT with versioned ABI and generation fences. Sealed mode rejects runtime source/code compilation, unbounded runtime class/method creation, unrestricted reflection, monkey-patching, unknown proxy targets and silent interpreter/JIT fallback **before executable IR**.
- **Compile-time mechanisms:** retain inheritance, virtual dispatch, generic/typeclass specialization, hygienic macros and statically compiled closures, async frames and actors through a finite closed-world reachability registry. Proxies are typed build-time forwarders/interceptors for known classes or finite interfaces; do not expose private members or misclassify static methods as instance methods.
- **Memory safety:** every allocation and closure/frame/actor state has checked `rt take`/`rt copy`/`rt borrow`/`rt share` ownership, explicit drop and bounded quota/OOM. Strong cycles require safe weak/region strategies; long-lived actors need reclamation *before* termination. No borrowed references, raw pointers, hidden host capabilities or function/closure objects through channels/pub-sub. Cleanup and revocation across `await`, cancellation, restart and I/O must be generation-fenced and exactly once.
- **Language rules unchanged:** no implicit conversions, no operator overloading, no `%`/`^`/`^^` operator reintroduction, no automatic nested `Future`/`Option` flattening, no guest-to-host logic relocation just to pass source tests. Keep canonical `.atto`; legacy `.ores` is migration-only.
- **Claims:** distinguish host AOT from full guest AOT and guest zero tracing-GC from process zero-GC. Do not infer hard real-time guarantees merely from arena allocation or non-GC drop.

## Backend boundary

A Wasm module emitted ahead of time can use explicit linear-memory ownership while JavaScript host/Web Workers may still use GC/JIT. Compile real actor/async guest state machines, preserve worker-isolation and transfer validation, and distinguish JS-host simulations from executed exported wasm guest results.

## PR / conformance test gate

| Compile/execute positive `.atto` | Reject or stress |
| --- | --- |
| Known-class proxy forwarding, static facade, virtual method reachable in linked artifact | runtime eval/class injection, unknown proxy, private method escalation, open-world reflection, missing tree-shake edge |
| Owned closure capture, bounded task frame across suspension, actor message move/copy | escaping borrow, strong cycle, closure sent via channel, use-after-move/double drop |
| Long-lived actor churn, shutdown/restart/cancellation during I/O | quota exhaustion, stale actor generation, teardown race, invalid pointer/handle |
| Real emitted AOT guest artifact + native/Wasm guest execution | source-only fixture, parser-only check, host mock, interpreter fallback, empty job steps |

Report exact main/PR head and tree SHA, canonical fixture blob, compiler executable hash, target artifact digest, runner and nonzero executed steps, and allocator/GC instrumentation. `steps=[]` or `steps=null` means runner-admission failure / **NOT_EXECUTED**. Unimplemented strict-profile constructs must fail closed; no JIT workaround. No claimed five-backend parity until independently verified.
