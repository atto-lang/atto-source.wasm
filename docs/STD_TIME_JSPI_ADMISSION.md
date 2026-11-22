# Browser/Wasm std/time JSPI admission boundary

This repo now has a **standalone host-side** experimental JSPI adapter,
`src/stdlib-time-jspi.mjs`, distinct from the backend-owned
`stdlib/std/time.atto` library. Its imports are NOT admitted by the default
isolated Wasm worker: that worker still instantiates untrusted modules with
`new WebAssembly.Instance(module, {})` and rejects ambient host imports.

`createTimeJspiBoundary()` creates a trusted-owner-controlled
`WebAssembly.Suspending` import function for a future compiler-emitted
`atto.time.sleep_ns` ABI. The call takes a lossless signed-64-range
nonnegative nanosecond `bigint`, checks deadline overflow and rejects
nonmonotonic samples. Timer registrations are capped at 64 by default,
use an event-loop tick even for zero, rearm after early wakeups and
reject invalid/nonfinite or regressed time samples. Closing the owner
cancels all pending suspension Promises and releases their admission slots.
Only an independently verified trusted host-import admission layer may
attach this import to a guest; **do not inject it into the current no-import
guest worker or treat constructor injection as a sandbox capability.**

`npm run test:std-time-jspi` verifies the host boundary and independently
proves the existing guest worker remains import-empty. These are not
compiled `.atto` guest tests, and not full JSPI execution inside Chromium.
Implementing compiler import linking, typed Duration lowering, cancellation
through the actor's scheduler and actual browser Worker JSPI e2e remains
necessary for parity with the Java/LLVM runtime plans.
