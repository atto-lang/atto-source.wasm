# AttoLang `std/time` (native .atto)

Implementation: `stdlib/std/time.atto`. Public import: `std/time` or
`atto.std/time` when disambiguation is required. This backend owns its
own .atto source; no cross-repository shared-source dependency is introduced.

## Implemented in this change

- `Duration` is exact nonnegative nanoseconds, with checked ns/us/ms/s/min/h
  constructors, checked +/−/×, and millisecond floor/ceil conversion.
  Positive submillisecond delays round **up** for millisecond-only schedulers.
- `Instant` represents a monotonic snapshot, never wall-clock/Unix time.
  `clock_id` enforces comparison domain equality, but is not an authority
  token. Untrusted callers can construct it; do not accept one as proof of
  an authenticated deadline without a trusted runtime clock provenance check.
- `Deadline`: checked construction, inclusive expiration at now >= due,
  remaining time clamped to zero, explicit domain mismatch.
- `Timer`: owner-local, once-only, pollable lifecycle; cancel before firing.
- `Interval`: owner-local fixed-delay, no unbounded catch-up. Late polls
  coalesce missed periods and rearm relative to observed monotonic time.
  Overflow halts the interval with an explicit error.
- `examples/atto-time-contract.atto`: a native guest fixture with deterministic
  assertions (construction, rounding, overflow, clock mismatch, no-early
  deadlines, one-shot firing, cancellation and interval coalescing).

## Runtime work not yet implemented

These are **value types and state machines**, not a scheduler or true timer
driver. In particular, merely polling a Timer cannot suspend a task.

1. Implement the native platform `Clock` backend and unforgeable clock domain;
   expose separate monotonic and wall-clock reads. Java already provides
   `process.monotonic_ns()`; this module wraps it as `monotonic_now()`,
   with a process-local domain marker. Do not serialize its Instants.
2. Implement `await sleep(Duration)` and `await sleep_until(Deadline)`
   with a timer queue that holds a pinned task/actor continuation; do not
   park an actor carrier. Always recheck the monotonic deadline on wake.
3. Implement `sleep_blocking(Duration)` **only** on parkable fibers;
   browser main thread / JS event loop / actor carrier must fail closed.
4. Integrate cancellation, actor teardown, timer handle generations, bounded
   registration, and race-safe one-time wake completion.
5. Replace the provisional `Result<..., String>` with typed TimerError /
   CancelledError once native error contracts admit those types.

## Representation limitation

The first native `Duration` uses an Atto signed `int` nanosecond count
bounded by 2^63−1. `atto-spec#47` discusses checked **unsigned** duration
literals. Full unsigned representation and duration literal lowering are
separate compiler milestones; this implementation must not silently accept
an out-of-range unsigned literal or claim that the full spec is implemented.

## Required verification

Execute `examples/atto-time-contract.atto` on each exact backend head,
check **all** TIME-PASS lines and TIME-CONTRACT-DONE, and add negative
compile tests and scheduler-backed tests for early wake, cancellation races,
teardown, clock-domain mismatch, AOT and overflow. A source-only review or
host-language arithmetic model is not an executed Atto guest test.

Upstream context: atto-lang/atto-spec#47; atto-lang/atto-source.rs#226.
