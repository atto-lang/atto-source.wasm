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
