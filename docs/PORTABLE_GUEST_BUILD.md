# Opt-in portable Wasm guest build

The experimental compiler branch adds `oreslang-llvmc --target=wasm32`. To build a pinned core-i64 guest artifact:

    node scripts/compile-ores.mjs --compiler=/absolute/oreslang-llvmc --source=/absolute/main.ores --output=/absolute/guest.wasm --environment=browser

The compiler stdout must contain a wasm32-unknown-unknown target triple; the bridge links with Clang, verifies the core Wasm module and rejects host imports. It writes guest.wasm.artifact.json (versioned schema in oreslang-target-profiles) with an exact binary digest and bounded memory, plus guest.wasm.provenance.json. This is a pure, scalar-only ABI; it is not a source effect proof, shared MIR, WIT component or public stable compilation command. The compiler option is still a proposed PR until merged.

## Bounded compiler and artifact reads

Inputs are checked by descriptor, not by a separate `stat` followed by
`readFile(path)`. The bridge uses nonblocking no-follow file opens, rejects
symlinks and special files, verifies initial and final inode/size/mtime,
and enforces limits **before allocation**: 1 MiB of Oreslang source, 256 MiB
of compiler executable and 16 MiB of linked Wasm. Its metadata reads remain
independently integrity-checked by the atomic release reader.

These controls provide fail-closed filesystem input admission and snapshot
integrity; they do not sandbox an intentionally malicious native compiler.

## Opt-in scalar f64 guest profile (experimental)

The default stays `core-wasm.i64-v1` with the exact `() -> i64` entry. To
exercise LLVM's emerging binary64 source lowering, opt in explicitly:

    node scripts/compile-ores.mjs --compiler=/absolute/oreslang-llvmc --source=/absolute/main.atto --output=/absolute/float.wasm --profile=core-wasm.f64-v1 --environment=browser
    node scripts/run-guest.mjs --wasm=/absolute/float.wasm --sha256=PINNED_64_HEX --profile=core-wasm.f64-v1

The f64 profile requires an exact `() -> f64` export and retains the same
no-import, no-table, no-start, bounded-private-memory and disposable-Worker
requirements. It admits scalar f64 results only; no parameters, host I/O,
actors, vectors, Decimal, BigInt or nan-bit-payload canonicalization. CLI
results are strings to preserve `-0`, `NaN` and infinities. This does **not**
change the separate native Wasmtime/AOT runner's ABI, grant host capabilities,
or establish Java/LLVM/AttoLang source parity by itself.

`tests/wasm-f64-profile.test.mjs` uses real Clang-linked Wasm to prove the
Node core-Wasm host path. The separately gated
`tests/f64-atto-compiler-parity.test.mjs` only counts compiler-backed guest
execution when a pinned real LLVM compiler binary and exact source SHA are
supplied. An absent toolchain is **NOT_EXECUTED**, not a pass. Independent Java
and native LLVM guest receipts remain required for cross-backend certification.

## Core-only compiler and exact LLVM entry guard

The source bridge now invokes `--library-profile=core --tree-shake
--tree-shake-root=main --target=wasm32` for both scalar ABIs. Only the
`main` root is admitted. The pre-link checker requires exactly one
line-leading `define i64 @main()` or `define double @main()` and rejects
comments, metadata, quoted symbols, and duplicates. The post-link Wasm
validator still enforces the exact signature and zero imports.

Bridge shell stubs are not real AttoLang source execution evidence.
The LLVM float draft #1517 disallows f64 `main` and has unresolved
numeric semantics; compiler-backed f64 source parity remains
**NOT_EXECUTED / NOT_CERTIFIED** pending a reviewed Wasm-specific entry ABI.

## Pinned native f64 Core compiler argv

The i64 profile uses the established five compiler arguments; f64 adds the
explicit --wasm-core-abi=f64 selector before its staged source path. Both
retain --library-profile=core and --target=wasm32. No auto-detection, host
imports or source compiler fallbacks are permitted. LLVM PR #1517 remains
under review. Stub bridge evidence does not establish real source parity.

## Exact-head f64 approval and execution workflow (draft)

The source-only PR job in `.github/workflows/f64-exact-head-guest.yml`
executes Node regression and forged-receipt rejection tests, **without**
private compiler source, a compiler executable, credentials or a release
certificate. It cannot claim real compiler-backed guest execution.

The **separate manual** `approved-real-guest` job requires all of:

1. A protected/default-branch `workflow_dispatch`, not a PR dispatch.
   This job cannot be used for premerge certification of PR #408 while
   the workflow exists only on the draft branch.
2. An independently authorized source-bearing runner with exact labels
   `self-hosted, linux, x64, atto-f64-approved` and a configured
   `atto-f64-guest-approval` environment with independent reviewers.
   Merely naming the environment or assigning a runner label is not security
   approval.
3. A **pre-provisioned** absolute compiler path configured as repository
   variable `ATTO_F64_APPROVED_COMPILER_PATH` and a source-owned LLVM
   execution receipt at `ATTO_F64_APPROVED_RECEIPT_PATH`. No workflow step
   downloads the compiler, clones the LLVM repository or transfers source.
   Provisioning compiler bytes separately requires the source owner's
   explicit authorization.
4. Independently maintained environment secrets
   `ATTO_F64_APPROVED_LLVM_HEAD`,
   `ATTO_F64_APPROVED_LLVM_TREE`,
   `ATTO_F64_APPROVED_COMPILER_SHA256`, and
   `ATTO_F64_APPROVED_RECEIPT_SHA256`. Missing or stale pins fail closed;
   the first three bind the source receipt and compiler, and the fourth binds
   the exact receipt bytes authorized by an independent reviewer.
5. An actual `npm run test:f64-compiler`-equivalent Node test that compiles
   canonical `.atto` into Wasm and executes a 3.75 return in a disposable
   Worker with **zero imports and zero host capabilities**. The same test
   checks that an i64 entry cannot be published under the f64 profile. A
   guest execution receipt is written only after all these checks succeed.

`scripts/f64-evidence-admission.mjs` enforces source SHA, root tree SHA,
compiler SHA-256, approved receipt digest, all three source-owned executed
CTest IDs and the exact f64 Worker outcome. Its negative tests reject
forged, missing, stale, skipped and overclaiming receipts.

If all evidence checks succeed, the Wasm workflow publishes **hashes and
JSON receipts only**, explicitly marking Java comparison `NOT_EXECUTED`
and release `NOT_CERTIFIED`. Wasm binaries and the private native compiler
are not uploaded. The experimental artifact schema in target-profiles
PR #89 needs its own independent validation and approval.

**Current status:** Neither PR-head LLVM compiler execution nor approved
Worker execution has been observed. No approved runner/compiler-provisioning
configuration has been established by these draft changes. A zero-step
failed CI run is not a test failure or a test pass.
