# Draft: canonical bang-suffixed exceptional control (AttoLang)

**Proposal date:** 2026-11-20. **State:** draft, not an executed backend parity claim.

## Canonical spellings

- `trap! expression` — caller-side capture of an ordinary, typed failure as `Result<T, E>` (including an existing `Result`; no implicit Option conversion and no catch of panic).
- `trap! fnc ...` — where the existing callable trap modifier is available, spell that modifier with the same contiguous suffix.
- `throw! error` — typed `Error`-subclass payload, nearest applicable `try/catch`; otherwise escalates under existing actor rules.
- `raise! error` — typed `Error`-subclass payload, skip ordinary catch, target nearest `defer/recover`; otherwise escalates.
- `panic! error` — typed `Error`-subclass payload, terminal actor failure and supervisor CONTROL notification; actor cannot intercept its own panic.

The `!` must immediately follow the keyword in source bytes. The suffix is part of the operator spelling, **not** logical-not. This proposal does **not** change `!=`, `!eq`, ownership-bang operators, `?`, effect annotations (`throws/raises/panics`), or the existing typed error and supervision semantics.

### Examples (illustrative syntax, not executable evidence)

```atto
let accepted: Result<Ack, Error> = trap! worker.send(42);
throw! new ValidationError("invalid request");
raise! new StateError("unrecoverable in this scope");
panic! new FatalError("terminate actor");
```

## Rollout / compatibility

The suffixed forms are the **only canonical spelling for new Atto source**. Previously admitted bare `trap`, `throw`, `raise`, and `panic` remain *migration spellings* while existing fixtures and dependent frontends transition; their eventual removal needs a spec/versioned migration gate rather than a surprise break of old code. Backends without checked effect lowering must emit a clear rejection for canonical forms, never silently execute them as ordinary functions or host exceptions.

## Backend note

Wasm host/worker integration must not synthesize guest exceptional control. Admission and guest execution depend on a verified Atto compiler.

## Review and verification gates

- Test exact contiguous spellings, space-separated `trap !`/etc., identifiers such as `trapped`, string/comment trivia, and inequality/ownership punctuation collisions.
- Verify positive parse, negative type/effect diagnostics, `Result` capture identity, panic escalation and supervisor CONTROL routing **only** on backends that genuinely implement these semantics.
- Separate lexer/parser tests, static source checks, host simulations, and actual AOT/Wasm guest execution. A missing or zero-step execution is **NOT_EXECUTED**, not a pass.
- Before promotion or merge, reconcile overlapping in-flight feature work (notably `atto-source.rs` #327/#331, `atto-source.llvm` #75, `atto-source.net` #117, `atto-source.wasm` #51, `atto-source.java` #67), and obtain exact-head CI and required independent approvals.
