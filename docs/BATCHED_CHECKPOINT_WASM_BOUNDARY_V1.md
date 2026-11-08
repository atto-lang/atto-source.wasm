# Untrusted Wasm checkpoint boundary — v1 audit

There are two *different* Wasm execution paths:

- `aot-host/profile.rs` configures **Wasmtime deterministic hard fuel** with
  `consume_fuel(true)`. `aot-host/run/src/tenant_isolation.rs` sets bounded
  per-invocation Store fuel and retires a failed Store. Do NOT replace precise
  Wasmtime fuel with 128/512-loop batched polling: that would weaken hard quota
  guarantees for unknown instruction costs, recursion and nested calls.
- `src/isolated-runner.mjs` executes the admitted zero-import scalar Wasm
  profile in a disposable Node worker with a bounded wall deadline. It has
  no checkpoint injection, and Node Worker isolation is NOT a production
  OS sandbox. The regression here checks a **real infinite Wasm loop** is
  terminated and a fresh benign guest can still execute.

**Target compiler contract:** Optional soft scheduler polls every 128 bounded
work units (64/256/512 only when configured), no expensive runtime polling
on ordinary iterations. Hard fuel accounting remains independent and exact.
`rt cooperate` may actually suspend only at heap-owned continuation boundaries
and outside no-yield scopes. Unknown FFI costs and arbitrarily long Wasm
instructions must fail closed or be bounded externally.

This PR adds interruption evidence only; it does not implement the separate
128-unit source-IR instrumentation or resumable Wasm actors. The AOT prototype
must keep its debug-only caller-pin gate until authenticated artifact approval.
