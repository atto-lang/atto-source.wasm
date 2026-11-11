# AttoLang checked-dispatch portable conformance v1

This is the same canonical, UTF-8 `.atto` source corpus in each `oreslang-source.*` repository. The Git blob SHA for each source file and oracle manifest MUST match between backends; divergence blocks a parity claim. Guest source uses `.atto` and snake_case function names.

| Case | Requirement | Expected real guest observation |
| --- | --- | --- |
| `direct_call_42` | Statically resolved free-function call, with no source-level target substitution | Native/guest return 42 |
| `instance_call_42` | Nominal instance method, hidden receiver and borrow admission | Native/guest return 42 |
| `static_qualified_42` | Qualified static class method, no virtual receiver lookup | Native/guest return 42 |
| `virtual_override_121020` | Base-typed receiver dispatches Child's override, static members remain separately qualified | stdout exactly `121020` |
| `wrong_arity_reject` | Mismatched source-call argument count | Compiler diagnostic and no emitted IR/artifact |

**Every new case is NOT_EXECUTED by default.** Files and oracle rows do not establish execution parity. A backend can promote a case to PASS only with real compilation and guest execution on the **unchanged** fixture at a verified exact source head, recorded Git blob IDs, executed steps, compiler/toolchain fingerprint, exit code/stdout and artifact digest where relevant. A synthetic host model, a stub, a JUnit source-shape check, or a zero-step CI job is **NOT_EXECUTED**, not PASS.

## Semantic and safety invariants

- Direct calls require a checked resolved target in the same immutable generation. JIT observations, source names, comments and macro text are not authority to devirtualize.
- For instance methods, use a stable nominal owner and method selector (name and **source-visible** arity) and preserve private visibility, receiver loans, effects, ownership and capabilities. A checked base-class slot is **not** an exact runtime-implementation proof.
- Base-typed Child calls must use the Child override. Methods with the same name in unrelated classes must not alias. Non-exact runtime class, imported/foreign code-image and hot-reloaded generation use a virtual or versioned fallback.
- Qualified static methods are nonvirtual and must not be resolved by the instance method table. Callable values use indirect calls; actor sends retain mailbox admission.
- Unsupported constructs reject **before emitting IR or executable artifacts**. A syntax rejection of `wrong_arity_reject` is not equivalent to proof of arity checking.
- Optional runtime JIT is orthogonal to guest correctness. Native Image of a JVM interpreter is **host AOT only**, while LLVM/CLR/Forge native guest code and precompiled Wasm need separate evidence. Do not claim acceleration without benchmarks and real IR inspection.

## Source-inspection baseline, 2026-11-11

| Backend | What currently exists | Required gap |
| --- | --- | --- |
| Java/GraalVM | Draft Java PR #2814 checked AST plans and guarded evaluator binding | Full JDK/GraalVM guest tests and independent native guest AOT absent |
| LLVM | Bounded nominal instance-method native lowering and direct function AOT | Inheritance, virtual and static methods not yet supported; new-corpus native receipts absent |
| .NET | Strict scalar CIL -> NativeAOT source subset; host-side nominal ABI model | General free calls, classes, virtual/static method lowering absent |
| Wasm | Pinned LLVM compiler, Clang wasm32 and `() -> i64` zero-import worker host | Class capability depends on LLVM and target; JS Wasm compilation is NOT strict no-JIT |
| Forge | Experimental x86-64 real direct-call compiler; draft Forge PR #260 adds canonical `int value` alongside legacy `value:int` syntax | Executed canonical direct-call receipts pending; instance/static/virtual class dispatch absent |

No backend is marked PASS merely because it has a fixture. Do not downgrade full-language requirements to a restricted dialect; unsatisfied cases remain explicit implementation tasks.

## Verification promotion

1. Compare all five Git blob SHAs for the 5 fixtures and `cases.tsv`. Source-only parity is not compiler parity.
2. For direct calls, run actual native code with variable/runtime inputs or inspect the real non-folded `call` instruction, not just a constant return 42.
3. Validate `wrong_arity_reject`: compiler-owned semantic failure plus **no output IR/binary**. Record a syntax rejection separately from a typed arity diagnostic.
4. Implement and execute the instance and qualified static cases where unsupported, preserving ownership and separate receiver/static lookup.
5. Implement virtual dispatch with override, class-identity/arity collision tests and generation invalidation. The base-typed override fixture must produce exactly `121020`.
6. Prove no-JIT/native guest AOT on exact target toolchains, O0/O2, sanitizer/ownership negative cases and release artifacts; report each backend independently.

Do not export private source to another organization for CI without the source-side independently approved policy, private destination IDs, protected origin and exact carrier/test-plan attestation.
