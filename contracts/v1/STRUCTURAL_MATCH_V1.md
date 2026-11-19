# Oreslang structural matching contract v1

**Scope:** free `fnc`, `routine`, class and actor methods, callable signatures,
arguments and `match value over ... end`. This is a common **semantic
target**, not an assertion that each backend already implements it.

## Orthogonal uses of `structural`

1. `fnc f(structural Shape value): int` means the *parameter* accepts an
   argument structurally. The same rule applies to routines and methods.
   The parameter is an implicit **read-only borrow**, not an owned move:
   a caller can reuse the original object after the synchronous call.
   `Shape value` without `structural` is nominal.
2. `structural fnc f(...)`, `structural routine f(...)`, structural class /
   actor methods and `@structural` describe **callable metadata**. This is
   separate from parameter matching. It does not structurally type unmarked
   parameters. The keyword and annotation forms normalize identically;
   specifying both is invalid.
3. `on structural Shape bound -> { ... }` and
   `on structural { x: int } bound -> { ... }` perform public-shape tests on
   a match subject. Named interfaces, traits and permitted class contracts
   supply required public fields and methods. Extra public members are allowed.
   Method parameter modes, return types, callable qualifiers and visibility
   must be compatible; a private member cannot satisfy a public requirement.

## Matching and ownership

```ores
match item over
  on structural { x: int, y: int } point when ready -> { consume(point.x); }
  on structural { x: int } point -> { consume(point.x); }
  on _ -> { handle_unmatched(); }
end
```

- Evaluate `item` once. Try canonical `on` arms in **source order**;
  the first successful pattern **and guard** wins. Detect provably
  unreachable arms, including a wider shape before a narrower one. A final
  `on _` covers unmatched cases. `default` / `else` are not canonical.
- Recursive fixed-arity tuples may mix nominal, structural and wildcard
  patterns. Match-list patterns are not admitted. `struct` and
  `infer struct` construct or infer types; neither is a substitute for
  `structural`.
- A structural view cannot be mutable, moved from, stored beyond its owner,
  sent through an actor mailbox, or retained across suspension/`await`.
  No actor identity may be silently erased. Match guards cannot widen
  privileges. Check public-member type and effect compatibility.
- `do match` is procedural. A value-producing `match` yields a result from
  each arm and supports a result type constraint. Declaration-level
  structural metadata does not alter either mode.
- The legacy `match item ... end` spelling has historical exclusivity
  proof behavior; `match first` was its ordered escape hatch. Do not
  implement canonical `match ... over` with legacy disjointness semantics.
- `structural` is contextual, not an unconditional ban on normal member
  identifiers named `structural`.

## Minimum conformance evidence before claiming feature parity

| Test | Required result |
| --- | --- |
| Function / routine / method, same public shape plus extra fields | Accept, same result |
| Nominal parameter without explicit `structural` | Do not implicitly structuralize |
| Missing/private member, wrong field type, wrong method mode | Reject |
| Reuse owner after structural argument | Accept without consuming owner |
| Mutate through structural parameter or match binding | Reject |
| Structural borrow escaping, crossing `await` or actor send | Reject |
| Named trait and inline shape match | Match identical subject |
| Recursive tuple structural matching | Exact arity, first-success binding |
| Narrow shape before broad shape | Accept in canonical ordered match |
| Broad shape before provably narrower shape | Reject unreachable arm |
| `on _` catch-all and guarded overlap | Respect ordered guard semantics |
| Canonical `default`, list patterns, actor-identity erasure | Reject |
| Native AOT, Wasm guest, Windows AOT and Forge native execution | Use compiled guest semantics, not a host-only mock |

**Admission rule:** A backend with no public-shape resolver, immutable loan
checking, typed binding/reachability analysis and executable lowering must
reject these forms *before* claiming a successful guest compilation. A
compiler merely recognizing or reserving the keyword is **not** parity.
A Wasm wrapper that invokes LLVM inherits LLVM's limitations.

**Known implementation boundary at adoption:** Java/GraalVM includes concrete
structural checker and match evaluator tests. LLVM has keyword recognition
and explicit fail-closed guards pending type/IR lowering. Wasm delegates to
LLVM. .NET and Forge remain arithmetic bootstraps; their rejection tests
protect against accidental admission. All five are **not** feature-complete
today. Each must graduate the test matrix above to positive runtime tests
before changing this status.
