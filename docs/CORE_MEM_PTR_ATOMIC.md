# `core/mem`, `core/ptr`, `core/atomic` (Wasm source candidate)

This Wasm compiler repository independently owns the source in
`stdlib/core/{mem,ptr,atomic}.atto`. Public arithmetic and ordering-policy
semantics are compatible with the Java core candidate, but implementation
files may diverge as each backend evolves. Nothing imports a shared canonical
Atto library implementation.

- `mem`: power-of-two alignment, checked align-up/stride, bounded array sizes
  and checked byte spans, returning -1 or false for invalid inputs.
- `ptr`: checked region-relative index offset and span arithmetic; no actual
  Pointer<T> creation, address casting, dereference or capability transport.
- `atomic`: memory order admission (relaxed/acquire/release/acq_rel/seq_cst),
  with default seq_cst; validates compare-exchange success/failure orderings.
  **No Atomic<T>, CAS, RMW, fence or shared storage is implemented here.**

All operations are pure `.atto` source with no host interop, OS, allocator,
scheduler, actor authority or GC dependency. They do NOT authenticate
region provenance, bounds grants, actor incarnation, live loans, initialization
or ownership. Arithmetic checks are necessary but insufficient for memory
safety. The compiler/runtime must enforce these rights and fail closed.

The source-only 63-vector harness is
`node --test tests/core-memory-policy-source.test.mjs`. It is a deliberately
restricted scalar source checker, not an Atto compiler. It is NOT native guest,
full AOT, threading/atomic, pointer safety or cross-backend parity evidence.
The Wasm compiler has not yet imported/linked/executed these modules
in a guest. Unsupported intrinsics must remain explicitly rejected.

Relevant independent efforts: Java
[atto-source.java #1771](https://github.com/atto-lang/atto-source.java/pull/1771),
LLVM [#801](https://github.com/atto-lang/atto-source.llvm/pull/801),
Rust local-pointer [#419](https://github.com/atto-lang/atto-source.rs/pull/419),
[atomic specification #175](https://github.com/atto-lang/atto-spec/pull/175)
and conflicting [pointer specifications #18](https://github.com/atto-lang/atto-spec/pull/18)
and [#154](https://github.com/atto-lang/atto-spec/pull/154).
