# AttoLang std.process — Wasm host ABI policy

This backend owns `stdlib/process_policy.atto` and the regression
`tests/fixtures/std-process-policy-v1/main.atto`. They implement only pure
byte bounds, quotas, deadline and exit predicates; they are **not** a host
process API. The expected fixture result is 42 if a real Atto compiler can
link and execute it.

## Unsupported default

Core WebAssembly/browser and zero-import core-Wasm execution **must
reject `process.spawn`**. There is no ambient executable, shell, process
table or OS PID. Web Workers are not OS child processes.

A distinct future `host-process` import ABI may be admitted in an
explicitly authorized server runtime only. The host must validate grants,
executable identity, environment/cwd/file access, resource quotas and
caller actor authority. A host-supplied options bag, untrusted import
name or Wasm module flag cannot confer RUN authority. The imported process
handle is generation-bound and owned; stdio streams are bounded,
backpressured async byte streams. Cancellation must cause physical
retirement, and process exit must not be confused with task cancellation.

The existing [Wasm JIT process isolation PR #181]
(https://github.com/atto-lang/atto-source.wasm/pull/181) is a separate,
development-only *host runner*, not guest arbitrary `std.process`. Do not
reuse its untrusted-worker launch permission as guest subprocess authority.

## Evidence

Source only: parsing/typechecking, linked import, executable .atto guest,
WebAssembly AOT and all host-process behaviors are **NOT VERIFIED**.
Never mark this as working subprocess support on browsers.
