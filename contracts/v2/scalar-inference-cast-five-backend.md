# Oreslang five-backend inference, checked casts and SSA mutation contract — v2

**Scope:** Java/GraalVM, native LLVM, LLVM-to-wasm32, .NET structured source/CIL, and the independent Cranelift native JIT. Authored source/tests are not execution receipts; do not claim full parity from a shared file or one backend's pass.

## Normative source rules

```ores
const int annotated = 7;
const inferred_cast = 7 as int;
const inferred = 7;
int immutable_by_default = 7;
let mutable = 7;
mutable = 42;
```

All first four declarations create fixed/readonly `int` bindings. The explicit `const` annotation checks initializer compatibility; `as int` performs a checked expression cast; bare inference determines the initializer type independently. **A cast must not be used to hide incorrect bare inference.** The `let` binding alone grants rebinding. Mutability of a *binding* must never silently grant mutation authority over its *referent*; actor state remains owner-scoped.

`const` does **not** mean every initializer must execute at compile time: runtime-dependent initializers are valid and are evaluated eagerly once, in lexical order. Subsequent `let` writes create new value versions, not a mutable alias to an earlier `const` snapshot. Checked i64 overflow occurs even in unused eager initializers.

A checked identity cast cannot change numeric representation, enable mutation, drop ownership checks, or reinterpret actor/Option/ADT handles. No implicit conversions, no operator overloading, no `%`, `^` or `^^`. Where `as?` is supported, its type is `Option<T>`, never `T`. Backends without an Option runtime tag must reject `as?` before code generation rather than pretend an identity cast produced a value.

## Capability matrix (implementation proposals, **not** execution certification)

| Feature | Java | LLVM | Wasm32 | .NET | Cranelift |
| --- | --- | --- | --- | --- | --- |
| Inferred `int`, `bool` | Yes, verify tests | Draft scalar yes | Via pinned LLVM | Draft structured scalar yes | `int` only |
| Typed vs inferred `int` declaration | Yes | Draft | Via pinned LLVM | Draft structured subset | Draft |
| `as int`, `as bool` checked identity | Yes | Draft | Via pinned LLVM | Draft structured subset | `as int` only |
| Immutable default / fixed `const` | Yes, contract | Draft | Via pinned LLVM | Draft structured subset | Draft |
| Explicit `let` rebinding | Yes | Draft | Via pinned LLVM | Draft | Draft SSA versions |
| `as?` to `Option<T>` | Java type checker | Not lowered; reject | Reject | Reject | Reject |
| Nominal, ADT and generic casts | Java-specific checks | Incomplete | Incomplete | Incomplete | Incomplete |
| Physical actor heap/ownership parity | Separate gate | Separate gate | Separate gate | Separate gate | Not a sandbox |

## Minimum executable test vectors

Each backend must support its *documented* intersection or reject unsupported features with a precise diagnostic. Require independent positive and negative compiler programs for:

1. `const int x=7`, `const x=7 as int`, `const x=7`, `int x=7` separately and in combination.
2. Parameter/local/helper/parenthesized arithmetic cast precedence, chained identity casts, signed64 MIN/MAX and checked overflow in an unused initializer.
3. `const` initialized from runtime parameter or local, with a single read and repeated reads.
4. Mutable `let` reassignment through multiple versions; `const snapshot=letValue` retains the captured version after later writes.
5. `const`/`val` reassignment, undeclared binding, forward/self reference, duplicate name, reserved `as` or type keyword as identifier: compiler rejection.
6. `true as int`, `7 as bool`, mismatched annotated binding, optional cast into untagged `int`, dynamic/nominal cast with no RTTI: compiler rejection.
7. `rt take` + checked cast cannot hide use-after-move; `rt borrow` may not gain mutable authority.
8. Operators `%`, `^`, `^^` reject wherever removed; do not restore them to pass a test.

## Repository review and evidence

- Java/GraalVM: `oreslang-source.java` PR **#2405**. Require executed JUnit and Graal guest evaluation, not parser-only fixtures.
- LLVM: `oreslang-source.llvm` PR **#1256**. Require C++ compiler build, LLVM native guest compile/link/run, sanitizer/ownership negatives, exact compiler hash.
- Wasm32: `oreslang-source.wasm` PR **#219**. Require source-bound LLVM compiler SHA-256, wasm32 triple, atomic publication manifest, isolated guest receipt, no imports or release on negative.
- .NET: `oreslang-source.net` PR **#282**. Require typed parser, CFG reference evaluator, emitted CIL interpreter, deterministic PE and **separate** NativeAOT executable evidence.
- Cranelift: `oreslang-source.cranelift` PR **#34**. Require `cargo fmt --all -- --check`, `cargo test --locked --all-targets`, `cargo clippy --locked --all-targets -- -D warnings` and real native JIT CLI positive/negative cases; JIT is not a sandbox.

Review and record each exact PR head, Git tree SHA, compiler artifact digest, executed workflow attempt/job/step list, positive guest receipts, negative rejected-artifact evidence, independent review, and protected-branch status. **Zero-step Actions failures are runner admission failures, not compiler failures.** Skips and host-only checks must never count as guest execution. Do not transfer private source across organizations without explicit authorization.

Known unresolved gaps: Cranelift `bool`, `as?`, actors and nominal casts; LLVM Wasm and .NET full dynamic/Option/ADT semantics; complete Java-to-native ownership/heap isolation parity. Keep all companion PRs draft until independent execution and review establish otherwise.
