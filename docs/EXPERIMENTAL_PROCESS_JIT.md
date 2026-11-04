# Experimental AttoLang Wasm JIT process runner

**STATUS: development-only scalar Wasm execution, not production sandboxing or a source actor runtime.**

The new `runExperimentalProcessGuest` API launches a one-shot child **OS process** using
`process.execPath`. That process calls the existing strict `core-wasm.i64-v1`
admission module, JIT-compiles an exact byte snapshot with V8, invokes
`main: () -> i64`, and exits. The parent reports a result **only after**
the child has terminated; a deadline kills the child, without relying on
`Thread.Abort` or a cooperative guest loop.

This is an incremental improvement over in-process Node worker threads. A
process is a useful lifetime/failure boundary but **NOT** a hardened
hostile-tenant OS sandbox. It currently lacks Linux namespaces/seccomp/cgroup
setup, process-wide RSS limits, tenant-authenticated actor identity,
per-actor mailbox/continuation semantics, native Wasmtime fuel/epoch metering,
and full `.atto` compiler/actor integration. Node's `--max-old-space-size`
caps only a V8 heap dimension; it does NOT bound native/JIT/RSS allocations.

## Development invocation (not a production execution authorization)

```js
import {runExperimentalProcessGuest} from './src/process-guest-runner.mjs';
const outcome = await runExperimentalProcessGuest(wasmBytes, {
  unsafeDevelopmentMode: true, // REQUIRED; without this, fail closed
  expectedSha256: pinnedImageSha, timeoutMs: 2000, maxMemoryPages: 2,
});
console.log(outcome.value); // bigint from genuine scalar WebAssembly main()
```

The child receives no ambient environment and no WASI/host imports. Its
parent-side snapshot SHA-256 is checked before execution and echoed in a
validated reply. An external SHA-256 alone is **not** a release signature
or actor authorization. The worker is short-lived and its concurrency
quota is local to the importing Node module, not across processes/tenants.

The returned `execution` receipt deliberately includes
`hostileSandboxCertified: false` and `attolangActorExecuted: false`.
Do not promote this to `REAL_ATTOLANG_GUEST_EXECUTED`.

## Test and promotion

```sh
node --test tests/process-guest-runner.test.mjs
```

The regression tests cover real Wasm (compiled to machine code by V8), SHA
pins, host import refusal, unsupported configuration rejection, nonshared
linear memory across invocations, and termination/recovery from a non-
cooperative CPU loop. These are **not** full AttoLang actor compiler tests.

For production promotion:
1. Use a supervisor-governed Wasmtime JIT worker in a restricted OS process
   with validated fuel/epoch interruption plus reliable process termination.
2. Enforce process-wide native/JIT memory, compiler-time, actor/message quotas,
   explicit capabilities, actor ownership and generation fencing.
3. Connect the real `.atto` compiler, actor lowering, mailbox, cancellation,
   cross-tenant refusal and hot-upgrade life cycle to the worker.
4. Demonstrate real backend guest compilation/execution, negative fault
   scenarios, exact source head/tree/fixture/image identity and nonzero-step CI.
5. Obtain independent review of the sandbox and any private source export.

Contract: https://github.com/ores-truffle-oreslang/oreslang-platform-conformance/pull/332

## Pinned Wasmtime 49 development JIT binary (source-only until native CI)

A second execution candidate now lives in
`aot-host/precompile/src/bin/oreslang-jit-dev.rs` (the existing independently
pinned Wasmtime 49.0.3 Cranelift build graph). It JIT-compiles **raw** admitted
core Wasm via `Module::from_binary`; does not deserialize attacker-supplied
native AOT artifacts. It reuses the existing bounded no-follow Wasm file
reader, strict source section guard, exported ABI check, Wasmtime fuel and
store memory limits. The command is **deliberately disabled by default** and
its debug-only `insecure-dev-jit` Cargo feature cannot enable release builds,
even when release assertions are forced.

Development-only test command (requires Rust 1.96, Clang wasm32 and LLD):

```sh
bash aot-host/tests/jit-dev-smoke.sh
```

That smoke script is committed, and an exact-head GitHub Actions JIT job is
configured, but **the Rust binary has not compiled or run successfully in this
change**: the local container lacks Rust, and sampled GitHub Actions runs have
`steps=null` (runner admission, not a compiler/test verdict).
Its CLI is **not** an OS process broker, hostile-tenant sandbox, signed-image
admission service, or AttoLang guest actor runtime. Do not deploy it to
production or promote it from source review alone.

## November 4, 2026: fail-closed protocol audit

The initial process runner killed its child immediately upon receiving any
IPC message, including a successful result. That prevented checking whether
the guest child could naturally disconnect and exit cleanly. The current
runner instead verifies the response **before** accepting it, waits for
a zero-exit/no-signal `close`, and keeps the timeout active until physical
termination; a post-reply abnormal exit is a failure.

Process launch option admission now requires an ordinary, own-data-property
object (no accessors, symbols, inherited opt-in, or unexpected fields).
One immutable configuration snapshot is used for validation and launch.
Positive result envelopes have exact allowed fields only, no
`productionCertified` or other fake proof extensions, and the successful
admission receipt is frozen after validation. The child's negative response
cannot bypass these positive-evidence gates.

The Rust smoke additionally requires a **fuel-specific** diagnostic for
loop interruption and an **import-admission-specific** diagnostic for host
import refusal, rather than treating any nonzero exit as success. The Node
test suite also covers four simultaneous spinning guests, fifth-admission
denial, quota release after actual child exit, accessor/symbol injection,
and real recursive Wasm stack exhaustion with subsequent supervisor recovery.

**Evidence scope:** the new 12-case integration test source has been committed,
but current hosted PR workflows report `steps=null`. Focused, source-extracted
local admission/response checks (14/14), static Rust/CI policy checks
(12/12), and a local Node 22 clean IPC-exit smoke passed. An independent
Clang 17/V8 recursive Wasm fixture produced a real stack overflow trap.
These checks are not a full run of the current PR's Node integration suite
and do not execute the Rust Wasmtime JIT binary or a genuine `.atto` actor.
No production sandbox certification is implied.
