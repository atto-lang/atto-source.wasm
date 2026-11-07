# Wasm real bridge argument-policy regression

A pinned, on-disk test compiler verifies the **actual invocation's** five
command arguments: exact `--library-profile=core`, tree-shaking policy,
`--target=wasm32`, and a staged canonical `.atto` guest source. The
successful tool output is independently checked as executable Wasm with
zero imports, a returning entry value and provenance SHA-256. The test
compiler is explicitly a **stub**, so this does not certify real LLVM
guest compilation. Tests also reject invalid/relative input paths.

The separate manual workflow must still use an independently approved
exact LLVM source head, protected `main`, authenticated private
read credentials and a source-bound real guest receipt. These controls
remain closed while GitHub runner admission and branch protection fail.

## Bad pinned-compiler IR cannot be published

Four new execution-level *stub tool* negative cases pass malformed LLVM IR
through the actual Wasm bridge: a host target triple, a triple only inside
a comment, duplicate target triples, and a missing `i64 @main()` definition.
Each must fail before writing a `.wasm`, provenance file or artifact
manifest, even when the test stub has a correctly pinned SHA-256.
This verifies the bridge's rejection boundary only; these are not real
AttoLang compiler guest runs, and should never be reported as parity.
