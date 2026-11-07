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
