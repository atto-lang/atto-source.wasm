# Structural positional tuple contract v2 (proposal; fail closed)

Status: target semantics as of 2026-10-16, **not executable parity evidence**.

This document augments `contracts/structural/v1/README.md`. v1 covers
named structural fields and structural pattern matching; v2 specifies
optional-tail positional tuple views and unambiguous explicit tuple spread.

## Source forms / semantics

- `tuple (int, int, string?)` and `(int, int, string?)` denote the
  **same** tuple-parameter type. The tuple keyword is contextual.
- In a tuple position, a trailing `T?` means an **omittable slot** whose
  observable value is `Option<T>`, whether supplied or absent; it is not
  permission to shift following required slots. Only a contiguous trailing
  suffix may be omittable. A supplied `T` is accepted; omission reads as
  `None`. Existing `Option<T>` means optional VALUE, not optional SLOT.
- `structural (int, int, string?)` is an explicitly read-only,
  non-escaping **positional width view**: a source tuple needs the
  required prefix and compatible types at every declared present slot;
  extra trailing positions remain in the source value and are invisible
  through the view. Exact tuple types reject excess positions.
- Tuple and fixed-array/list/record must not be silently conflated. The
  source must be a typed finite tuple (possibly a proven static alias),
  not a generic list/array or host iterable. Unknown type/size fails closed.
- The view must enforce invariant writable positions (no writable
  structural tuple view), no actor mail/async/suspend escape, no implicit
  numeric coercion through a readonly projected slot, no transport without
  independent sendability proof. Alias expansion must preserve authority.
- `v[i]` for an optional-tail declared slot returns `Option<T>` and
  returns `None` if the actual tuple omits it. The original source tuple
  is not padded/rewritten. Compile-time index out of range relative to
  the declared view is rejected even if the source carries extra slots.

## Calls and overloads

1. Expand a statically known `...(tuple)` once, in left-to-right
   evaluation order; no repeated evaluation or input mutation.
2. Try *ordinary* name+expanded-arity resolution first, including the
   existing compiler-bound nominal-enum exception if supported.
3. Only when no direct expanded-arity target exists, permit **one**
   implicit tuple pack at an explicitly spread tuple argument to a
   declared single-tuple-parameter callable; require a unique eligible
   target. This is NOT an implicit pack for `f(a,b)`, and never
   runtime/multimethod structural matching.
4. Retain independent instance vs static domains; calls on `fnc`,
   `routine`, bare/`method` instance methods and `static fnc`
   obey identical tuple-width rules. No same-arity overload families
   differing solely by structural shape, optionality or primitive type.
5. Unknown-extent spreads, mixed/ambiguous spread placements, unresolved
   imported/dynamic callable targets, missing bindings, or ABI mismatch
   reject at compile time. When the runtime cannot execute an emitted
   compile-time binding, no guest artifact is published.
6. The callee sees **one** tuple value after fallback packing. Argument
   ownership, readonly loans and cleanup follow exactly one invocation.

## Examples

```oreslang
pub fnc run(structural (int, int, string?) v): void {
  const first = v[0];
  const third = v[2];  // Option<string>, None when omitted
}
pub routine main(): void {
  run(...(5, 3));                 // valid: packed positional tuple
  run(...(5, 3, "foo"));          // valid: packed positional tuple
  run(...(5, 3, "foo", "start")); // valid: width view
  run((5, 3));                   // valid: one ordinary tuple argument
}
```

`run(...(5,3))` resolves to an existing two-argument overload first,
if one exists. A one-tuple-parameter overload never shadows the direct
two-argument overload.

## Conservative static proof limits

The initial static tuple/overload proof is bounded to **64 positional slots**
and **128 overload candidates**. Exceeding those limits is a diagnosed
compile-time rejection, not fallback to runtime shape comparison.
Unresolved/generic, mutable-borrowed or otherwise unproven tuple slot types
cannot certify a readonly positional view. A proof handle also requires a
nonempty compiler-bound callable ID. Future capability widening requires
separately verified ownership, borrow and ABI proofs.

## Required gates

All five repositories carry identical normative fixtures in
`cases.json`, with explicit pass/reject and semantic decision. A
contract-only or parser-only backend must report **NOT IMPLEMENTED**.
Do not alter the existing bootstrap negative tests just to make source
lexically accepted. For implementation parity require:
- parser AST equivalence + malformed optional-slot negatives;
- typechecker positive and negative admission, readonly capability;
- compiler-bound selected declaration and source evaluation once;
- executable per-backend guest tests plus target ABI checks;
- negative tests with nonzero diagnostics and no executable output;
- cross-repo identical fixture content and synchronized version.
Wasm must prove actual wasm32 compile/link and guest execution rather
than inheriting a host LLVM pass report.
