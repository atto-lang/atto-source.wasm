# Real native LLVM -> WebAssembly integration gate

**Current status:** new fail-closed gate added but it has not yet executed
against an actual Oreslang compiler. Neither stub compiler tests nor an
unallocated GitHub Actions job constitute compiler parity evidence.

## Trust and CI authorization

Workflow `.github/workflows/real-llvm.yml` is deliberately manual
(`workflow_dispatch`) to avoid providing secrets to unreviewed PRs.
Configure the private Wasm repository secret `ORESLANG_LLVM_READ_TOKEN`
with **read-only access only to** the private `oreslang-source.llvm` repo.
Without that secret, the workflow fails closed. It does not copy source to
public repositories, mirror across organizations, or assume the default
`GITHUB_TOKEN` has cross-repository permissions.

The workflow pins LLVM main revision
`0ee060aafbc079150541dac6d3ab6b177b7b1670`, checks the
exact checkout commit, builds `oreslang-llvmc`, and records the SHA-256
of the actual executable before running the integration gate.
This source commit is an immutable input, **not** proof of source/toolchain
parity beyond the actual tests.

## Local trusted runner

Build `oreslang-llvmc` from an approved pinned checkout, then set:

- `ORESLANG_LLVM_COMPILER=/absolute/path/to/oreslang-llvmc`
- `ORESLANG_LLVM_COMPILER_SHA256=<64 lowercase hex digits>`
- `ORESLANG_LLVM_SOURCE_SHA=<40 lowercase hex digits>`

Run `npm run test:real-compiler`.

The gate uses the existing explicit `--target=wasm32` compiler bridge
to compile `examples/native-int.ores`, publish a content-addressed
binary and manifest, require import-free bounded memory, execute it in a
disposable worker, and check a result of `42`. It also compiles an
intentionally invalid Oreslang file and requires a **compiler rejection
without artifact publication**.

Missing inputs, hash mismatches, invalid compiler output and failed
execution cause nonzero exit. The script itself cannot independently prove
that a user-supplied executable came from a claimed Git commit; only an
audited build environment can establish that relation.

## Blocked hosted CI

Current private-repository GitHub-hosted Actions jobs are failing before
any steps execute. Code changes cannot establish runner funding or
permissions. Verify organization Actions settings, billing/minutes,
and runner allocation; use only a separately authorized **private**
CI carrier after the required private-mirror permission checks.
Do not merge a draft PR based solely on local tests or skipped compiler
integration checks.
