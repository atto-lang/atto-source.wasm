# Option pattern / flow refinement parity v1

Status: **candidate contract, not a parity certification**. Java/Graal is the
reference implementation under test; native backends have narrower source
grammars. No backend may report this feature as implemented merely because it
rejects unsupported source or passes a source-only schema test.

## Canonical semantics

```ores
let Option<Foo> m2 = None;
m2 = Some(new Foo());
if m2 matches Some(foo) then
  foo.run();
fi
```

- `None` is explicit absence, not `null`. Uninitialized `Foo m2;` does **not**
  imply `Option<Foo>`; definite assignment is a separate compiler obligation.
- `Some(foo)` binds `foo: Foo` only on a successful true branch; it cannot
  escape into `else`, a later `elif`, or following statements after `fi`.
- `A && B` short-circuits and allows `B` to use bindings proved by `A`.
  `A || B` must **not** assume `A` succeeded.
- Pattern destructuring is an ownership alias, not an implicit deep copy.
  Nested `Some` and stable field/index projections keep their containing
  ownership root. Moving the same move-only payload/owner twice is rejected.
  A Copy payload (e.g. `int`) does not consume its move-only holder.
- All backend implementations must eventually prove parse, type checking,
  definite assignment, ownership, runtime branch evaluation, and error paths.

## Shared source and executable admission evidence

Each `oreslang-source.*` backend carries *byte-identical* copies of:

- `contracts/v1/option-pattern-v1.json` — nine reference-source vectors and
  their Java expected admission result, including three valid executions.
- `scripts/check_option_pattern_contract.py` — strict inventory checks and a
  **real compiler** check when the backend supplies its CLI.

The script requires an executable compiler command with an explicit
`{source}` placeholder; it cannot silently skip unavailable compilers.
Before negative unsupported-feature checks, the LLVM/.NET/Forge modes compile
a valid scalar source as an always-fail-compiler guard. Rejecting an Option
fixture **only proves fail-closed admission**, not matching semantics or
relative runtime parity. Report data contains case IDs, source SHA-256 and
compiler exits, not private source or fabricated runtime results.

### Backend evidence levels

| Backend | Present capability | Required next evidence |
| --- | --- | --- |
| Java/Graal | Source parser, type/ownership analysis and interpreter paths for Option patterns | Targeted `OptionIfMatchesTest` JUnit, reference admission matrix, actual guest runtime execution, JDK 25 native-image AOT/hybrid at exact PR head |
| LLVM | Restricted scalar, stack class and CFG subset; no full `Option<T>` pattern lowering | Executed native rejection with scalar-positive control, then real typed ADT lowering and the shared positive/negative matrix |
| .NET | Arithmetic source compiler and Native AOT host bootstrap | Executed compiler rejection with scalar-positive control, then typed Option CIL and Windows Native AOT execution |
| WASM | Bridge to pinned LLVM compiler; no independent Option parser | Source inventory only in ordinary CI; opt-in pinned LLVM toolchain rejects unsupported source with exact LLVM identity; guest Wasm semantics remain pending |
| Forge | Independent arithmetic parser/interpreter bootstrap | Executed compiler rejection with scalar-positive control, then Option parsing/type checking/IR/guest runtime |

No source org currently has verified executable CI evidence for the updated
feature head. Runs with zero steps or zero test artifacts must never be
misreported as compiler or runtime passes.

## Private CI restrictions

Do **not** copy private repository trees into another organization merely
because its Actions budget is available. The Java repository requires a
protected origin `main`, approved exact private destination in its reviewed
allowlist, independent CODEOWNER approval, a verified destination-bound
publisher and exact immutable subtree/commit provenance. Source-free synthetic
Git-tree tests do not grant source-export authority.

This fixture contract contains newly authored minimal language examples;
it is **not** permission to mirror or publish repository source trees.
