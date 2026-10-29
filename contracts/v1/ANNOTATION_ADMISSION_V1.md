# Oreslang annotation admission v1 — common backend corpus

All five source backends carry the identical `annotation-admission-v1.tsv`. The corpus is deliberately an **admission floor**, not a claim that the backends have equivalent annotation AST, macro expansion, serialization or security semantics.

- `shared-deny`: all backends must reject the source before executable code is produced (Java via checked parsing / expansion; LLVM and native bootstraps via source admission; Wasm at the preflight bridge).
- `bootstrap-deny`: LLVM, Wasm, .NET and Forge must reject. Java may retain a user-defined annotation as metadata; its end-to-end semantics are not certified by this corpus.
- `shared-allow`: all frontends must continue to parse an ordinary scalar source, including annotations appearing only in lexical comments.

TSV has exactly three tab-separated fields, with a literal `\\n` encoding source line breaks. Every test runner rejects malformed rows, empty IDs, duplicate IDs or unknown kinds. Backends must not pass a negative test merely because a different backend is unavailable. For native/AOT failures, verify nonzero exit and no generated IR/artifact when the compiler harness supports that check.

## Compatibility policy

Java/GraalVM currently supports typed `@FromJson` field expansion and selected AST/type metadata; the other bootstraps do not. The recognized LLVM `@ActorMaxThreads` syntax is capability-guarded and is **not** generalized annotation support. Until a shared closed-world registry, checked argument types, target restrictions, hygienic expansion and generated-code rechecking are implemented, unknown or security-relevant annotations must not be accepted as authorization or optimization claims.

Do not silently lower unsupported metadata as a no-op, infer authority from marker strings, execute runtime reflection, or treat parse-only metadata as enforcement. Exact-head compile/execute tests and nonzero-step CI are mandatory before promoting drafts.
