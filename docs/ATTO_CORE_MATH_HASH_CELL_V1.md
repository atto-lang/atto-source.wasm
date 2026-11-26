# Wasm-local core math, hash and cell policy (candidate v1)

Independent `library/atto.core/{math,hash,cell}.atto` sources cover the
portable signed-i64/math, noncryptographic byte folding and *pure* borrow
policy subset. Each is Git-blob pinned by a Node source-admission test,
which also validates golden arithmetic vectors.

**SOURCE_ONLY / NOT_EXECUTED**. Wasm currently delegates real guest
compilation to the native LLVM backend and its scalar bridge rejects all
Atto `import module` source forms before publication. Therefore a file
in the Wasm repository is **not** an importable, executable core module.
The negative test explicitly preserves this fail-closed behavior.
`contracts/core-math-hash-cell-v1/guest.atto` is a future real Wasm guest
candidate, not a passing fixture. Promotion requires:
1. authenticated/pinned LLVM compiler source SHA, compiler binary SHA256,
   LLVM registered Core imports including PR #869, and consistent exact
   source module graph fingerprint;
2. actual wasm32 compiled/linkable module from `.atto`, observed 42 in
   isolated guest, no ambient host imports, and tracked artifact hashes;
3. rejects unknown or traversal Core imports without partial Wasm;
4. exact-head nonzero stepful CI and independent review.

Cell<T> and RefCell<T> do not exist here. Policy helpers never authorize
a memory loan, worker sharing, lock or mutable alias. No browser JS
implementation is used as a substitute for Atto guest code.
