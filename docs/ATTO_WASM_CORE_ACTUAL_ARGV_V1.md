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

## Exact single LLVM IR entry definition

The Wasm bridge previously used an unanchored substring regex for
`define i64 @main()`, so a commented or metadata string containing
that text could pass the *pre-link* check. Validation now requires
exactly one line-leading real `define i64 @main()` declaration.
Four adversarial pinned-stub cases—comment-only, metadata-only,
duplicate entry, and quoted symbol—are each exercised in both legacy
and atomic publication modes (eight negative executions). Every
failure must leave no Wasm binary, provenance, manifest, or release
pointer. These test the bridge's fail-closed publication boundary, not
native AttoLang LLVM compiler parity.

## Valid-entry positive controls in both publication modes

Two corresponding positive controls use a pinned, explicitly labelled
stub compiler to produce one genuine `define i64 @main()` header.
The real bridge must link, validate and execute the returned Wasm `42`
guest in both **legacy** and **atomic** publication modes. Both must
report zero host imports, hash the same published Wasm bytes and retain
the exact pinned compiler SHA. The stub's output is not evidence that
AttoLang source was compiled by a real LLVM compiler; the separately
authorized real LLVM guest lane is still required.

## Canonical Core entry-root lock

The Wasm bridge always invokes the native compiler with
`--tree-shake-root=main`. It now denies any requested
`exportName` other than `main`, rather than accepting an
unverified alternate entry point and claiming main-root
compilation as evidence for a different exported symbol.
Five input variants are tested with an invocation sentinel;
all must reject before executing any compiler or writing a
published Wasm binary. Additional entry roots require
a separately specified, verified root/ABI/ownership contract.
This remains stub-policy evidence, not real LLVM guest parity.
