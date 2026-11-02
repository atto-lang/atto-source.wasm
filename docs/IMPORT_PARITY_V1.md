# AttoLang import parity v1 — LLVM-to-Wasm promotion gate

The canonical AttoLang project-root import marker is `+/`, **not** `@/`.
Java/Graal is the behavioral reference for manifest-root selection, nested
package contexts, declared `pkg:alias/path` dependencies, and whole-program
linking. This Wasm backend consumes a separately pinned LLVM compiler. It
does **not** implement a separate source import parser or linker.

## Required contracts

1. `+/src/lib/util` resolves under the nearest physical `.ores.pkg.toml`
   package root; `pkg:alias/path` uses a declared, verified zed dependency.
2. Both rooted namespace forms require forward slashes, reject empty,
   `.`, and `..` path components, and never fall back to ambient
   search paths on a missing target. `@/` is rejected.
3. Nested package roots have distinct source identities. A symlink must not
   let a rooted or package import escape its physical declared root.
4. Source validation, code generation, and Wasm publication must all bind
   to one exact, complete verified input graph and compiler binary digest.
5. All guest imports remain denied under the current zero-capability core
   Wasm profile. A verified linked AttoLang program may contain multiple
   source units, but the resulting core Wasm guest cannot acquire host
   imports, tables, start sections or unbounded memory.

## Current implementation and strict promotion rule

`npm test` exercises the Wasm bridge, provenance and admission gates but
does not prove source-to-Wasm compilation. The opt-in
`npm run test:real-compiler` gate uses a pinned native LLVM compiler, Clang
and isolated Wasm guest execution. It currently verifies signed-i64 scalar
programs and rejects source import directives for `+/...`, `@/...`,
`pkg:...` and `./...` rather than pretending imported code was linked.

After LLVM supports actual wasm32 import graph lowering, **replace** these
negative tests with positive tests that compile and execute multi-file
`+/...`, `pkg:...`, nested-manifest and diamond import fixtures.
Only then may this backend claim functional import parity. A passing
source-free test, a skipped workflow or a failing runner with no executed
steps is not compiler/runtime evidence.
