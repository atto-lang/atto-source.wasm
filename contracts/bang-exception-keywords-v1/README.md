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

## Cross-compiler reconciliation (2026-11-20)

This contract is **not** a Wasm source compiler feature. Verify these
separate implementation surfaces rather than inferring parity from a spelling
in a README:

| Surface | Relevant current PR | Required evidence |
| --- | --- | --- |
| Rust source/wasm32 | [atto-source.rs #449](https://github.com/atto-lang/atto-source.rs/pull/449), [#331](https://github.com/atto-lang/atto-source.rs/pull/331) | bang lexer adjacency, typed Error and Result, actual compiled guest |
| Wasm scalar integration | [atto-source.wasm #51](https://github.com/atto-lang/atto-source.wasm/pull/51) | independently pinned Rust compiler plus compiled Wasm Result guest |
| .NET | [atto-source.net #117](https://github.com/atto-lang/atto-source.net/pull/117) | real CIL/NativeAOT Result guest rather than IR-only simulation |
| JS source | [atto-source.js #97](https://github.com/atto-lang/atto-source.js/pull/97) | unsupported effects rejected before ESM publication |
| Forge | [atto-source.forge #183](https://github.com/atto-lang/atto-source.forge/pull/183) | unsupported Result/trap sources rejected before native object emission |

The scalar LLVM-backed bridge must not claim support for `trap!` simply
because the host verifies a separate Rust-produced Wasm binary. Keep a
positive parser/guest test separate from a negative unsupported-source gate.

### Required lexical regression vectors

- Admit an identifier `trapped`, strings `"throw!"` and `"panic!"`,
  and comments containing these spellings as inert text.
- Distinguish contiguous `trap! value` from `trap !value` and likewise
  for `throw!`, `raise!` and `panic!`. Never rewrite all `!` punctuation.
- Preserve `!=`, `!eq`, `borrow! mut`, `pipe!`, `rpipe!` and
  `stop!` as separate operators with their own semantic contracts.
- Reject bare non-`Error` thrown values, and ensure panic is not
  intercepted by `trap!`; a nonactor top-level panic needs an explicit
  runtime policy, not a fabricated supervisor.
- Require exact-head, nonzero-step source-compiler plus guest tests before
  recording any parity success. Documentation changes alone are not evidence.

## Delegated compiler executable gate (candidate, not executed)

This repository is a Wasm host; `atto-lang/atto-source.rs` supplies the actual
Atto-to-Wasm compiler. It is **not** a second independent source compiler.
The Rust candidate [#449](https://github.com/atto-lang/atto-source.rs/pull/449)
now has typechecked positive `throw! Error(...)` and `raise! Error(...)`
guest fixtures, a distinct canonical `trap!` Result rejection, and exact
guest stdout/return oracles.

`scripts/verify-exception-bang-wasm.mjs` provides a **real WebAssembly
compiler-artifact and generated-guest verification gate**. After an authorized
party independently reviews a private Rust compiler Wasm build, run with the
approved binary and its SHA-256 (without any network request, token, or
publication):

```sh
node scripts/verify-exception-bang-wasm.mjs \
  /approved/private/atto_compiler.wasm \
  <independently-approved-sha256>
```

The gate requires zero compiler-host imports and the known compiler ABI v2,
checks compiler byte identity and memory bounds, compiles and **executes two
real guest Wasm programs** with their expected numeric results and exact
throw/catch/finally and raise/recover traces, and checks three negative
source programs for phase-correct `E_TYPE` /
`E_TRAP_BANG_RESULT_UNVERIFIED` rejection **with zero output artifact**.
Unapproved binaries, wrong ABIs, unverified guest exports, unexpected guest
imports, malformed error memory and forged success fail closed.

### Bounded compiled-guest host isolation

The approved-compiler gate now runs each successful compiler-generated
guest in **a separate Node subprocess**, never in the synchronous CI control
thread. A valid guest may loop forever or print endlessly; JavaScript timers
cannot interrupt WebAssembly inside the same thread. The subprocess has a
**5-second** execution deadline, a bounded V8 heap, a **64 KiB child output**
buffer, an exact Wasm i64 return requirement, **zero exported panic_code**
(terminal failure must not masquerade as ordinary catch/recover), at most **4 KiB accumulated
guest stdout**, and the same allowlisted Atto print imports and memory bounds.
The generated Wasm binary is passed through subprocess stdin, not written to
a public artifact or logged. No user-defined `NODE_OPTIONS` is inherited.

The source-free synthetic test
`tests/exception-bang-isolated-guest.test.mjs` exercises a known i64
synthetic guest, **a forged i64 success with panic_code=1 that must fail**,
rejected i32 ABI, forbidden `env` import, an actual infinite Wasm loop terminated
by a child timeout, a 4 KiB+ print flood, malformed and oversized Wasm,
and a non-promoting receipt. These eight tests passed **8/8 in local Node 22**
using exact source files matched byte-for-byte to committed Git blob SHA-1
(`44db7d31c86d4d7744c96aab95b70d87e4dc2392` and
`d0225e31dcf1519f458ff35f8d5d3f298f29c0bd`); this is **host security testing only**.
The source repository still has zero-step Actions admission failures,
and no approved Rust compiler artifact or compiled Atto guest has been run.

The source-free tests in
`tests/exception-bang-wasm-gate.test.mjs` reject absent credentials/artifacts,
bad digests and fake compiler ABIs. They are included in `npm test`. A host
unit test pass does **not** certify emitted Atto guest execution; the positive
cases require a real independently reviewed compiler artifact from `.rs`.
This draft has **no such approved artifact or executed guest receipt** so far.
Do not transfer private compiler bytes to a new organization without
destination-specific authorization.


## Mandatory keyword separator (Atto-spec #244)

The approved compiler-artifact gate also demands 80 compact-keyword rejections with `E_BANG_KEYWORD_WHITESPACE` and no published guest artifact. Valid examples use `trap! (expr)` and `copy!! value`. This is a real compiler-artifact requirement, not an independent Wasm frontend implementation or a passing evidence claim. The upstream Rust compiler must be updated and independently approved before this gate can qualify.

### Separate candidate lexical gate

`node scripts/verify-bang-separator-candidate.mjs <candidate-compiler.wasm> <expected-sha256>` exercises 80 real compiler-ABI rejections and verifies deterministic recovery with an executable scalar control. This is a separate candidate scope, **not** independent artifact approval, full exception/actor semantics, or a replacement for the unchanged approved-artifact gate. The compiler and runner must be exact-source authenticated and resource bounded by CI.
