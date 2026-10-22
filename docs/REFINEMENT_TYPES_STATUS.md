# Refinement types: Wasm parity status

**Status (2026-10-17): delegated admission only. No independent Wasm refinement parser, lowering, runtime validator, or guest parity is claimed.**

Canonical contract: https://github.com/ores-truffle-oreslang/oreslang-common-source/blob/design/refinement-types-three-syntaxes-20261017/docs/REFINEMENT_TYPES.md

The Wasm backend compiles Oreslang through an explicitly supplied native `oreslang-llvmc` and then verifies wasm32 IR/artifact boundaries. Therefore refinement admission is delegated to the exact LLVM compiler binary. Until LLVM implements checked refinement semantics, a real positive scalar compilation must succeed and all proposed refinement sources must fail with a nonempty diagnostic and **no partial LLVM IR**.

`tests/refinement-admission-delegated.py` performs that gate against a caller-supplied pinned compiler. It is intentionally not part of ordinary Node tests because a synthetic or absent compiler cannot establish semantic admission.

Even after LLVM parsing exists, Wasm still needs its own runtime-boundary evidence for generated validators, serialization, actor DATA, imported artifacts, Unicode code-point length, and any Zorde descriptor consumed in a Wasm host.

## Zorde opaque proof refusal (delegated to native LLVM)

The delegated real-compiler harness also checks six Zorde `Valid<T,SchemaId>`
negative inputs, including qualified, nested, bare and constructed references.
Unlike a generic unsupported-language assertion, **each proof case requires
the exact dedicated LLVM proof-security diagnostic** and rejects partial IR,
success or silent crashes. This cannot pass merely because a different parser
failed to recognize `type` or generic syntax. The scalar positive control
ensures a trivially broken compiler cannot appear to pass.

These are *LLVM source admission* results only. Wasm has no validated proof
minting, actor/message transfer semantics, runtime immutable ownership or
hot-reload generation support. Real tests must use the exact reviewed native
compiler binary on an approved source-local runner; no synthetic substitute
or cross-organization private-source mirroring can certify this.

## Inclusive comparison spelling

Canonical textual inclusive bounds are `gte` and `lte`; symbolic `>=` and `<=` are equivalent source spellings. Legacy `ge` and `le` are deliberately invalid and must never be accepted as aliases. Until this backend implements checked refinement lowering, both canonical/symbolic valid refinements and legacy-invalid refinements remain fail-closed admission cases rather than erased base types.
