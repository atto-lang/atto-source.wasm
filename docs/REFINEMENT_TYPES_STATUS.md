# Refinement types: Wasm parity status

**Status (2026-10-17): delegated admission only. No independent Wasm refinement parser, lowering, runtime validator, or guest parity is claimed.**

Canonical contract: https://github.com/ores-truffle-oreslang/oreslang-common-source/blob/design/refinement-types-three-syntaxes-20261017/docs/REFINEMENT_TYPES.md

The Wasm backend compiles Oreslang through an explicitly supplied native `oreslang-llvmc` and then verifies wasm32 IR/artifact boundaries. Therefore refinement admission is delegated to the exact LLVM compiler binary. Until LLVM implements checked refinement semantics, a real positive scalar compilation must succeed and all proposed refinement sources must fail with a nonempty diagnostic and **no partial LLVM IR**.

`tests/refinement-admission-delegated.py` performs that gate against a caller-supplied pinned compiler. It is intentionally not part of ordinary Node tests because a synthetic or absent compiler cannot establish semantic admission.

Even after LLVM parsing exists, Wasm still needs its own runtime-boundary evidence for generated validators, serialization, actor DATA, imported artifacts, Unicode code-point length, and any Zorde descriptor consumed in a Wasm host.
