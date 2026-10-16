# Oreslang structural typing and pattern matching — parity contract v1

**Status (2026-10-15): target language semantics, not an implementation-parity claim.**
The Java/Graal implementation is the current reference. LLVM, .NET, Forge, and the
LLVM-dependent Wasm toolchain must not report conformance until the source tests
below compile, type-check, and (where applicable) execute natively.

## Three different meanings (do not conflate)

1. `fnc consume(structural Shape x)`: opt-in structural *parameter* matching.
   A candidate value is compatible when its accessible public instance shape
   contains all required fields and methods of `Shape` with compatible types.
   Extra members are allowed (width subtyping). Bare `Shape x` stays nominal.
2. `structural fnc f(...)`, `@structural routine f(...)`, and structural
   member declarations: callable declaration metadata; they do **not** imply
   structural matching of parameters that lack their own `structural` modifier.
3. `match value over on structural Shape x -> {...} ... end` and
   `on structural { field: Type } x -> {...}`: shape-tested patterns
   that refine the binding inside their arm; tuple patterns can contain
   structural subpatterns.

`structural` is contextual syntax: a callable or member may itself be named
`structural` when the token is in identifier position.

## Compatibility and safety

- Match public visible instance members only; inaccessible/private members
  do not satisfy a contract. Check member types and methods' complete
  parameter/return signatures and mutability modes, not just member names.
  Function parameter variance is contravariant, result variance covariant
  where type-system rules prove safety.
- Never substitute numeric/string coercions for type compatibility. Do not
  collapse actor identities into structural shapes.
- A structural parameter is a non-escaping, read-only synchronous view.
  No mutating structural arguments, actor-mailbox crossing, async/generator
  suspension, or escaping borrows until explicitly proven safe by an
  independent ownership/effects rule.
- In a `match ... over ... end`, evaluate guards on a successfully
  shape-tested value, keep bindings arm-local, and preserve any readonly
  capability. Diagnose *provably unreachable* subsequent arms; a previous
  broad shape subsumes a narrower shape. Tuple/nominal/structural patterns
  must use the same underlying type-compatibility relation.
- Structural compatibility does **not** introduce type-based overload
  selection: Oreslang callable dispatch remains name+arity first, subject
  to its explicit nominal-enum overload exception.
- Runtime shape tests must inspect Oreslang type/public-member metadata;
  accidental agreement of host-language object layouts or opaque
  references must not count. Missing metadata must reject or fail closed,
  never fall back to truthy/dynamic dispatch.
- A negative compiler test passes only when the compiler emits a useful
  non-zero diagnostic and publishes no runnable guest artifact. Lexical
  recognition by itself is not support.

## Cross-backend conformance checklist

Each backend must report separately: lex/parse, typed positive and negative
admission, ownership/effects, native/runtime dispatch, match-arm guards and
reachability, and executable target artifact. Required fixtures:

1. Structural interface/trait/class parameter with extra public fields: accept.
2. Same argument to a nonstructural nominal parameter: reject.
3. Missing required field, wrong field type, private-only field: reject.
4. Method signature mismatch, argument mode mismatch: reject.
5. `fnc`, `routine`, bare/`method` instance method, static `fnc`:
   equivalent explicit structural parameter rules.
6. `@structural` vs `structural` callable metadata: AST equivalence,
   without parameter-typing side effects.
7. Named, inline, and tuple structural patterns: typecheck, execute,
   bind matching shape, and respect guards.
8. Broader match arm preceding narrower: unreachable-arm diagnostic.
9. No mutation through a readonly match binding.
10. No structural actor erasure or mailbox/suspension escape.
11. Wrong value at runtime: take fallback arm, never read missing member.
12. Contextual identifier called `structural` remains legal.
13. Compile-only success must not be labeled runtime parity; mock/fake
    compilers do not count as native/Wasm execution evidence.

## Backend-specific implementation evidence

- **Java**: `StructuralTypingHardeningTest` and
  `StructuralTuplePatternMatchTest` already cover significant cases,
  including a Graal runtime program. Extend beyond parser-only smoke tests.
- **LLVM**: reserved word exists, but `Parser.hpp` models an i64-oriented
  limited AST; add typed structural type/record representation, type checker,
  pattern decision tree, public metadata and native lowering before marking
  positive fixtures as supported.
- **.NET**: current CIL/NativeAOT bootstraps accept constrained `main`
  arithmetic/CFG, not typed structural method calls; add full frontend,
  typed aggregate IR and ABI before native admission.
- **Forge**: current single-function parser/IR cannot express structural
  contracts; extend frontend/IR and native execution rather than treating
  acceptance of token text as support.
- **Wasm**: uses LLVM's compiler, not an independent frontend; source parity
  depends on verified LLVM output **plus** real wasm32 linkage, module
  admission and execution of the same conformance program.

## Conformance gate

Until every positive and negative fixture is confirmed on its actual target,
record the backend as **NOT AT PARITY**. Keep pre-implementation bootstrap
rejection tests green; after implementation, replace their negative
expectations with positive + negative typed and executable conformance suites.
Do not weaken the restrictive bootstrap grammars merely to make a fixture
appear to pass.
