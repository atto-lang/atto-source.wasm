# AttoLang browser compiler trust contract v1

The playground consumes **two independent WebAssembly modules**:
(1) an externally pinned compiler \`atto_compiler.wasm\` and
(2) each compiled user's import-free guest Wasm. A browser/compiler server
is not required. This contract governs admission of compiler *artifacts*,
not full AttoLang syntax or production tenant isolation.

## Pin and verify

Use \`verifyCompilerArtifact({wasm,receipt,trust})\` in a trusted
packaging/release job. The receipt must use schema
\`atto.browser.compiler.artifact.v1\`, \`target=wasm32-unknown-unknown\`,
\`abi=atto-playground-m0\`, and include exact source head, source tree,
compiler SHA-256, length, zero imports and exported symbol list.

The \`trust\` object **must not** be read from the artifact ZIP or
its self-issued receipt; it must be independently reviewed and pinned
through a trusted release/signing policy. A matching hash alone does not
authenticate a publisher. Both Git source head and Git tree are required.
A mismatch is a hard error, never a downgrade to the old M0 compiler.

The verifier checks core-Wasm magic, section bounds, absence of start,
explicit single bounded compiler memory (max 1024 pages / 64 MiB),
zero imports, ABI exports, and exact receipt export list. It returns a
compiled module only after all integrity and policy checks. Run
\`smokeCompilerAndGuest(admitted)\` to prove source-dependent 42/48
execution and negative immutable-rebinding rejection; a synthetic
policy fixture does **not** qualify as compiler-backed guest evidence.

## Deployment gates

- Compiler must be freshly built from an exact reviewed source head,
  and CI must have nonzero executed steps.
- Source Rust compiler CI publishes an artifact and a receipt. It does not
  itself certify who approved the artifact or replace the independent pins.
- The browser must receive only version-pinned, reviewed compiler bytes.
  Never fetch a moving \`main\` branch or accept self-signed manifests.
- Playground compiler and guest workers remain bounded, disposable, and
  have no host imports. A Web Worker is not an OS sandbox; public
  execution needs site isolation, CSP, quotas and abuse tests.
- Keep native Wasmtime AOT artifacts and actor guest ABI out of this
  browser compiler contract. Native AOT runtime PRs remain independent.

The test suite in this repository is **source-free policy verification**;
real compiler-backed proof is recorded in \`atto-source.rs\` and must be
repeated on the exact bundled playground artifact before release.
