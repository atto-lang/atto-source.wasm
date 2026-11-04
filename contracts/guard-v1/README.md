# AttoLang guard v1 cross-backend contract

Canonical source extension: `.atto`.

| Fixture | Required result |
| --- | --- |
| `canonical-scalar.atto` | Compile through the actual guest frontend, run at O0 and O2 (where applicable), exit with code 42, no guest stdout |
| `reject-fallthrough.atto` | Compile-time reject, no executable output or fallback |
| `reject-else.atto` | Compile-time reject, no executable output or fallback |

These three source files are required to be **Git-blob identical** in
`oreslang-source.java`, `oreslang-source.llvm`, `oreslang-source.wasm`,
`oreslang-source.net`, and `oreslang-source.forge`.

Current status: a target fixture contract. Java and LLVM have authored
positive/negative language paths and test harnesses, but exact-head guest
execution is **not yet verified**. Wasm, .NET and Forge are contract-only
until their compiler, type/ownership checker and runtime execute or reject
these source files as specified. Do not use host-language simulations as
guest evidence. A failed GitHub Actions job with `steps=null` is a
runner-admission failure, not a test failure or pass.

The `guard Option is Some` narrowing target remains separately
**NOT_IMPLEMENTED**; no backend may silently unwrap Option payloads.
