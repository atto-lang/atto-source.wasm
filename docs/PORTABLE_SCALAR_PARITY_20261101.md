# Portable Oreslang compiler parity — 2026-11-01

## Evidence classes and boundaries

The exact reviewed manifest `contracts/parity/portable-scalar-v1-20261101.json`
has Git blob `001e8894cbeb87509878a4de36263a1a327805b1`. The same
2,778 bytes are present in the current Java #2395, LLVM #1252, .NET #279 and
Wasm #218 draft branches. This is **source identity**, not compiler equality.

| Capability | Java/Graal PR #2395 | LLVM PR #1252 | .NET PR #279 | Wasm PR #218 |
| --- | --- | --- | --- | --- |
| 16 shared signed i64 positive values | Native TestSuite .ores authored | Identical native TestSuite .ores authored | Identical native TestSuite .ores authored | 16 import-free .ores programs generated from exact manifest, compiled via pinned LLVM compiler |
| 6 shared negative expressions | Source manifest authored; compiler rejection not executed | Same; compiler rejection not executed | Same; compiler rejection not executed | Fail-closed diagnosed LLVM compiler rejection, no release publication, **requires real compiler** |
| Full `ores.std/testing` guest | Java source registered; real guest proof pending | Unverified module resolution and lowering | Unverified module resolution and NativeAOT run | Unsupported by zero-import `() -> i64` Wasm ABI |
| Actor isolation, channels, async, structural types | Separate contracts, not proven here | Separate native tests/PRs; parity not proven here | Separate NativeAOT tests/PRs; parity not proven here | Not supported by the current import-free core Wasm bridge |
| Guest execution evidence | Not confirmed | Not confirmed | Not confirmed | Not confirmed: requires exact compiler pin and admitted stepful run |

## How to verify the Wasm scalar slice

Node 22, Clang with wasm32 target, LLD, an authorized real `oreslang-llvmc`
binary, and the required compiler/source pins must be available:

```sh
ORESLANG_SCALAR_PARITY_REQUIRED=1 \
ORESLANG_LLVM_COMPILER=/absolute/path/to/oreslang-llvmc \
ORESLANG_LLVM_COMPILER_SHA256=<actual_64_hex_digest> \
ORESLANG_LLVM_SOURCE_SHA=<reviewed_40_hex_source_commit> \
node --test tests/portable-scalar-parity-v1.test.mjs
```

The verifier refuses missing pins and changed executable bytes. Each positive
source goes through the native LLVM compiler and the real LLVM->Wasm bridge,
with source/compiler/Wasm digest bindings, bounded atomic release verification,
zero imports/grants and isolated WebAssembly execution. Each negative must fail
through the actual native frontend with a diagnostic and no published release.
A host-only manifest test or skipped optional real-compiler test **does not**
satisfy this gate.

## Remaining work to achieve full cross-backend parity

- Reconcile competing Java harness PRs #2393 and #2395 on one exact source tree.
- Wire the pinned `ores.std/testing` guest into actual JVM, LLVM and .NET
  compiler/runtime execution; check each case's unique `ORES_TEST` receipt and
  terminal summary, with fail-closed negative mutation evidence.
- Implement and independently verify a native test capability boundary for Wasm
  before attempting the full `TestSuite` API. Do not emulate guest tests in JS
  and count them as native Oreslang execution.
- Admit runners on authorized source organizations. Every CI pass must record
  exact compiler/std/source tree IDs, nonzero job steps, actual result receipts
  and independent approval. `steps=[]` means the runner never executed tests.
- Do not export private code across organizations while the incident hold is in
  force; a source-free canary measures only runner admission.

**Classification:** the shared scalar contract is **authored and pinned**;
language-compiler guest execution is **unverified**; full Java/LLVM/.NET/Wasm
feature parity is **not yet achieved**.
