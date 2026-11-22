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
The two `.atto` fixtures only specify expected behavior; simply adding them
does NOT assert they execute or that full generic functions are admitted.

The high-level callback helpers are an API target, not blanket permission
for non-Copy/affine callback capture. Reject unsupported generic/effect shapes
until the local compiler proves their safety.

Backend note: Wasm workers: never synthesize guest ADTs in JavaScript. Validate wasm32 guest artifacts, memory ownership and boundary ABI.
