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
disposable worker and check a result of `42`. A second distinct program
uses a same-module forward call and must return `47`. It also compiles an
intentionally invalid Oreslang file and requires a **direct native compiler
rejection with empty IR**, plus no artifact publication.

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

## Audit hardening: execution and provenance

The Node worker starts with an empty environment and without inherited
Node startup flags. These restrictions protect the trusted worker wrapper;
they **do not** make Node workers an OS security boundary.

The real native compiler must return **exit code 1**, empty stdout and an
`oreslang-llvmc:` diagnostic for intentionally invalid Oreslang code.
A signal termination, toolchain crash, or linker failure is not evidence of
valid compiler rejection. A real LLVM `target triple` declaration is
required; the same words in an IR comment are insufficient.

The ordinary and private-LLVM workflows pin checkout and setup-node actions
to immutable commit SHAs. The real-compiler workflow must still be executed
in a trusted, explicitly approved private environment with available runners.

## Manual full-suite verification before merging the draft PR

A secret-free manual workflow has been installed on the default branch:
`.github/workflows/manual-pinned-verify.yml`. This is intentionally
separate from the unmerged PR and accepts only an exact 40-hex commit SHA.

In the repository Actions UI, choose **Manual pinned Wasm PR verification**,
select **Run workflow**, and enter the latest exact draft PR head under
`source_sha` (find it on the PR's **Commits** tab; never substitute an
older SHA just because it appears in documentation). The workflow
checks out that SHA, verifies `git rev-parse HEAD`, installs Node 22,
Clang and LLD, and executes the complete `npm test` suite without access
to any private cross-repository secret. Its result is evidence **only for
that exact commit**.

A private CI-carrier experiment independently mirrored 22 files into
`3FA-app/3fa-api-server.rs`, branch
`test-oreslang-wasm-20261014`, at source SHA
`d6deb73d19727bf42f70bd43799cf63dd505558d`.
All 22 Git blob identities matched the source tree, but its workflow
[run 38653912932](https://github.com/3FA-app/3fa-api-server.rs/actions/runs/38653912932)
failed before any runner steps executed. This is **not** a passing test.
The mirror is a temporary testing branch, not an authoritative source.

The genuine LLVM compiler gate remains separate and cannot be treated as
passing until a trusted, explicitly authorized private runner completes
`npm run test:real-compiler` on the same reviewed source revision.

## Compiler-executable path-race closure

The native real-compiler verification gate now reads the executable through
`readBoundedRegularFile` and verifies its SHA-256 **before** writing it to
a private execution snapshot. Both positive source compilations and the
direct compiler-rejection check execute only copies of that snapshot. A
subsequently replaced input compiler pathname cannot alter the tested
frontend. This is a verified-byte identity guarantee, not a sandbox for
an untrusted compiler binary or a reproducible-build proof.

The diagnostic classifier requires a normal exit code of 1, empty LLVM
IR stdout, and a genuine `oreslang-llvmc:` error prefix; shell crashes,
unexpected exits and diagnostic spoofing fail the test.

## Mandatory native compiler wasm32 declaration

The bridge always invokes the native compiler using `--target=wasm32`, even
when there is no portable environment/manifest flag. An explicitly declared
`target triple = "wasm32-unknown-unknown"` must appear **exactly once** in
LLVM IR. Comments, string content, contradictory or duplicate triples, and
IR that merely happens to link with `clang --target=wasm32` are rejected
before linking or publication. The check lives in
`scripts/wasm32-ir-target.mjs` and has dedicated positive/negative unit
regressions. This is **not** a complete LLVM IR verifier; the native frontend
still must be pinned and its generated module verified.
