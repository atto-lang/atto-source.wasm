# atto-lang/atto-source.wasm — native Atto core Option/Result source candidate

These `.atto` modules are intentionally owned by this compiler and may
diverge in implementation from Java, Rust and other backends. Public semantics,
not shared source blobs, are the intended parity boundary.

**State: SOURCE_CANDIDATE; compiler admission and guest execution NOT_VERIFIED.**
The files under `core` are *not* automatically linked into the compiler's
standard library. Nominal type constructors and runtime representation remain
compiler primitives. These files must not create a host-language shim.

Supported public semantic targets:
- `Option<T>`: Some(T)/None, `flatten`, `map`, `and_then`,
  `or_else`, eager `to_result`, `transpose`.
- `Result<T,E>`: Ok(T)/Err(E), `flatten`, `map`, `and_then`,
  `map_err`, `or_else`, `to_option`, `transpose`.
- Exactly-once callback on the matching tag; never invoke on the other tag.
- `None` and `Err` remain ordinary values; `?` may only propagate
  compatible outer carriers and must run cleanup; callback throw/raise/panic
  retain their ordinary effect semantics.
- Every affine active payload moves once; inactive payload must not be read;
  moved values cannot be reused; drop exactly once on both success/failure.

**Required evidence before marking supported:** actual syntax/typechecking of
these .atto files, import and module resolution, link against correct nominal
ADT ABI, positive and negative compiled guest cases, active-payload ownership
and callback-effect tests, AOT compilation, current-head stepful CI receipts.
The four `.atto` fixtures only specify expected behavior; simply adding them
does NOT assert they execute or that full generic functions are admitted.

The high-level callback helpers are an API target, not blanket permission
for non-Copy/affine callback capture. Reject unsupported generic/effect shapes
until the local compiler proves their safety.

Backend note: Wasm workers: never synthesize guest ADTs in JavaScript. Validate wasm32 guest artifacts, memory ownership and boundary ABI.

### Additional parity vectors
- `tests/core_option_result/tag_zero_42.atto`: expected 42; distinguish
  Some(0) from None and Ok(0) from Err(0) using nominal tags.
- `tests/core_option_result/negative_nonexhaustive.atto`: must reject a
  partial Option match with no guest artifact.

Only Rust currently wires these new scalar fixtures into a native compiler
unit-test source. All other backends need real compiler harness integration,
and Rust itself still needs a stepful exact-head test receipt.

## Borrow-only source API & affine ownership admission (2026-11-22)

The independent `.atto` sources propose
`option.is_some_borrowed/is_none_borrowed` and
`result.is_ok_borrowed/is_err_borrowed` with checked
`borrow Option<T>` and `borrow Result<T,E>` formals. These
**inspect tags only**; their existence does not prove generic loan
lowering, Wasm/native memory safety, or consumption of affine owners.

`tests/core_option_result/borrowed_read_42.atto` is an authored,
**NOT_EXECUTED** positive compiler/guest target. Admit the source
using the actual backend compiler, execute a guest returning `42`,
and prove that both Option/Result owners remain usable after scoped
borrows end. `tests/core_option_result/negative_affine_borrow_escape.atto`
must be rejected specifically for unauthorized affine extraction from
a live loan, with **no guest artifact**. A generic parse failure, an
unsupported class construct, or a host-only test is not semantic
borrow-checker success.

The consuming helpers `flatten`, `map`, `and_then`,
`transpose` and `or_else` must require proven ownership modes
before moving non-Copy payloads; inactive variants must not be read;
exactly-once destruction, callback effects and outstanding loan
lifetimes must be checked across CFG, suspend, actor and error edges.
Any unsupported shape fails closed. Native AOT, sanitizers or Wasm
safety proofs are separate gates. No exact-head stepful compiler or
guest receipt exists for these authored candidates. Never copy private
compiler source to an unapproved CI destination.
