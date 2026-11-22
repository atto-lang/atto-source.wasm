# AttoLang std.process — Wasm host ABI policy

## Public library path contract (2026-11-22)

Atto's preferred public import is `std/process`; `atto.std/process`
is the explicit, disambiguating built-in import. Apply the same rule to
`std/process_policy` and `atto.std/process_policy`. Do **not** publish
`ores.std/process` or `ores.std/process_policy` as new import names.
The two accepted spellings must resolve to the same compiler-owned module
identity and source, not two copies or an unchecked filesystem path.
The `atto.std/*` root must be reserved against local-package shadowing.

This backend's current relative fixture imports and source-only policy
**do not establish that either hosted import alias is implemented** in its
compiler. Resolver registration, positive/negative guest tests and an
exact-head execution receipt remain required before calling namespace
parity implemented.


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
