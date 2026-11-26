# Oreslang five-backend security and private-CI parity contract

This document accompanies the **identical** `contracts/private-ci-security.v1.json` and
`scripts/check_backend_private_ci_contract.py` in these five privately
owned repositories: `oreslang-source.java`, `oreslang-source.llvm`,
`oreslang-source.net`, `oreslang-source.wasm`, and `oreslang-source.forge`.
The `backend-private-ci-contract` workflow runs a read-only local policy check
and negative regression tests. It **does not** transfer code or authorize a mirror.

## Mandatory shared security invariants

- Deny ambient filesystem, network, process, environment and FFI capabilities
  to untrusted guest programs. Unsupported language/runtime features must be
  rejected, never silently granted or replaced with unsafe host behavior.
- Do not infer permission to mirror a private repository merely because
  another organization has available GitHub Actions minutes. An export must
  have its **own source repository**'s reviewed destination allowlist on
  protected main, independent maintainer/security/code-owner approval, both
  source and destination immutable numeric GitHub repository IDs, and private
  destination visibility. An approval in another backend does not transfer.
- Mirror the entire reviewed source Git tree (commit + tree), independently
  verify destination blobs, root-tree preservation, commit ancestry and final
  ref, and record exact tested commit/tree SHAs and runner-executed steps.
  Tests that never executed are **not green**, even when GitHub reports a
  completed unsuccessful workflow or local structural checks pass.
- Same-repository read-only CI jobs must not persist checkout tokens. Policy
  enforcement for arbitrary changes still requires **protected main and
  independently enforced code-owner reviews**; a CODEOWNERS file alone
  does not enable GitHub branch protection.
- If a backend has not implemented a particular security mechanism or guest
  feature, its CI should prove **fail-closed rejection**. Never declare
  behavioral equivalence based on an identical manifest.

## Live capability assessment (October 15, 2026)

| Backend | Verified implementation scope from backend README | Security parity debt |
| --- | --- | --- |
| Java/GraalVM | Reference interpreter/runtime with scoped capability controls and actors; permissions hardening remains in draft PR #1034 | Real JDK25/GraalVM tests, OS-level isolation and host-interop escape review; integrate CI security stack |
| LLVM | Experimental compiler and native actor runtime fragments, bounded heaps and incomplete language features | Shared permission parser and effect enforcement; full actor/channel/select parity and native tests |
| .NET | Native AOT bootstrap for checked-i64 expressions; prototype byte mailbox | Guest permission API and deny enforcement, actors/borrows/async, Windows x64 Native AOT proof |
| WASM | Experimental zero-import Wasm guest host and LLVM compiler bridge with a limited scalar ABI | Explicit capability broker, OS isolation, actor/stream/ownership support and real native compiler end-to-end tests |
| Forge | C++20 bootstrap arithmetic compiler, checked interpreter and bounded byte mailbox | Real actor model, permissions, ownership, messages, network policy, native codegen and concurrency proofs |

**None of the four non-Java backends has demonstrated full Java runtime
feature parity.** Current cross-backend CI-policy agreement is a security
baseline, not proof that a missing compiler or runtime feature exists.

## Next executable conformance matrix

Every backend should run the *same input cases* and report
`supported + verified`, `unsupported + rejected`, or `broken` per case.
A missing feature cannot pass as an empty/no-op implementation:

1. Default-deny filesystem, DNS/TCP/UDP/HTTP, process execution, environment,
   FFI/reflection, unmanaged host threads and privileged host callbacks.
2. Explicit scoped grants, deny-overrides-allow, malformed and duplicate flags,
   path traversal/symlinks/TOCTOU and endpoint alias/IPv4/IPv6 behavior.
3. Owned-vs-shared-vs-sendable actor messages and serialization:
   local actor transport versus external JSON/MessagePack/Protobuf.
4. Actor single-flight scheduling, message backpressure, cancellation,
   `self.forward()` and `self.backward()`, broadcast and round-robin routes.
5. Strict source provenance, reviewed private runner admission and exact
   cross-org destination tree/commit/ref readback.
6. Native execution in each backend's real toolchain, with source Git tree,
   test-run IDs, output and binary identity recorded.

On this branch, run:
```sh
python3 -m unittest discover -s tests -p test_backend_private_ci_contract.py -v
python3 scripts/check_backend_private_ci_contract.py --backend BACKEND
```
where BACKEND is one of `java`, `llvm`, `net`, `wasm`, `forge`.
The GitHub workflow derives its backend from the repository name and checks
its immutable GitHub repository ID and private status. It is only a local
contract validator and cannot independently inspect other private backends.

## Executable guest-admission bootstrap corpus (new)

The identical versioned `contracts/guest-capability-admission.v1.json` now
contains nine reviewed Oreslang source cases: one admitted scalar program and
eight cases exercising **compile-time rejection** of unsupported filesystem,
network, process, FFI, actor, async, channel and serialization syntax.
`scripts/check_guest_capability_admission.py` pins SHA-256 for every program.
It fails if a source fixture changes, a compiler unexpectedly accepts a
rejected program, a compiler rejects the supported scalar, or a compiler
crashes/returns an unknown status rather than issuing normal rejection.

**Native test entrypoints (must really execute against a compiled compiler):**

- LLVM (after CMake build):
  `python3 scripts/check_guest_capability_admission.py --backend llvm --tool build/oreslang-llvmc`
- Forge (after CMake build):
  `python3 scripts/check_guest_capability_admission.py --backend forge --tool build/oresforge`
- .NET (in Windows Native AOT CI and Linux diagnostic):
  `python scripts/check_guest_capability_admission.py --backend net`
  (use `python3` on Linux)

The compiler subprocess gets a narrowly allowlisted toolchain
environment rather than the full GitHub Actions process environment.
Variables such as `GITHUB_TOKEN`, cloud API credentials and SSH tokens are
not forwarded; a regression fixture checks for these leaks. Compiler
timeouts, process crashes and unknown exit codes are never successful
capability-denial results.

The shared, read-only policy CI runs
`tests/test_guest_capability_admission.py` with mocked compiler responses.
**These mock tests are test-runner integrity checks only, not guest compiler
proof.** The LLVM/Forge/.NET native workflows run the real compiler admission
adapter as a required phase. A compiler's nonzero rejection does **not**
prove the requested privilege is inaccessible at runtime or that the OS
sandboxes an actor; it only proves the bootstrap compiler did not admit the
particular unsupported syntax.

The `java` and `wasm` **source-compiler** adapters intentionally return
an error rather than claiming parity. Java's permissions-specific runtime
JUnit suite belongs to its reviewed permissions hardening branch (#1034).
WASM now has an independent real-bytecode/worker test,
`tests/parity-zero-import-admission.test.mjs`, which constructs valid modules
both with and without a host import and checks the zero-import host boundary.
This is exercised by the WASM repository's existing `npm test` workflow;
actual GitHub runner evidence is still required. Neither backend can be
certified by the other three bootstraps' parser rejection results.

### Hardened regression and workflow integrity (October 16, 2026)

The shared guest compiler admission harness requires **normal exit code 1
plus a real backend diagnostic** (`oreslang-llvmc:`, `oresforge:` or
`oresnet:`) before treating rejected source as evidence. A command-line
usage exit, build/SDK/linker failure, crash, missing compiler, or other
non-compiler failure cannot produce a successful denial verdict. LLVM and
Forge additionally require **zero partial IR output** for rejected programs.

The nine source fixtures are SHA-256 pinned, category names and case schemas
are fixed, and the compiler subprocess receives only narrowly allowlisted
toolchain environment variables (no inherited GitHub tokens or cloud secrets).
These controls are backed by adversarial unit tests.

The source-local CI workflow is pinned by exact SHA-256 to reject commented
out tests, commented validation commands, unexpected trigger additions, or
weakened checkout/token settings. Its own checkout inspection explicitly
recognizes the reviewed *named* checkout step, with a separate `uses:` line.
This fixes an earlier regex that incorrectly required a `- uses:` line and
would have rejected the valid workflow on every backend.

**Execution evidence:** On October 16, 2026, all **16 local Python regression
test methods** passed using materialized files checked against the exact Git
blob IDs committed to the five coordinated PR branches. These are mocked
compiler/policy tests only; native LLVM/Forge/.NET compiler execution, Java
permissions JUnit, and the WASM worker's real runtime tests remain to be
verified by authorized runners. No source export to another organization
was performed.

## Security review and merge gate

Require security-owner review, branch protection with mandatory code-owner
reviews, and runner-executed tests on the final integrated head. Do not merge
a policy change or authorize private source transfer merely because the
manifest matches across repositories. Actual backend conformance requires
language/runtime tests that exercise the real compiled/executed guest code.


## Cross-backend compiler-admission diagnostic hardening (October 16, 2026)

The five repositories share **byte-identical** versions of the guest admission
checker and its tests. The checker now uses binary temporary files for compiler
stdout and stderr instead of unbounded capture_output=True memory buffers.
It reads at most 1 MiB plus one byte from each stream, requires strict UTF-8
without NUL characters, and rejects oversized or malformed diagnostics.
Timeouts must be numeric, positive and at most 300 seconds; return codes must
be genuine integers with value 0 (accepted) or 1 (rejected). Process crashes,
timeouts, partial IR, absent compilers, invalid diagnostics and unknown statuses
remain hard failures, never a successful capability-denial verdict.

This change is covered by five new Python test methods, including an **actual
synthetic Python compiler subprocess** that first emits valid accept/reject
results, then floods stdout to prove bounded diagnostic handling. On a local
executor, the shared security-contract suite passed 16/16 methods and the
guest-admission suite passed 19/19. Compiler-native proof is **not** established
by this synthetic compiler or by the mocks.

Existing native CI entrypoints (execution still requires an assigned runner):

| Backend | Real CI integration | Honest proof boundary |
| --- | --- | --- |
| LLVM | .github/workflows/ci.yml: CMake build, guest-admission checker, CTest | Native compiler parsing only if job actually runs |
| .NET | .github/workflows/windows-native-aot.yml: Windows and Linux diagnostic checker steps | Native AOT and compiler checks, not guest actor execution |
| Forge | .github/workflows/ci.yml: CMake build, guest-admission checker, CTest | Compiler and limited interpreter paths, not Java actor parity |
| Wasm | .github/workflows/ci.yml: npm test | Zero-import host checks; no guest admission adapter |
| Java | .github/workflows/ci.yml: Maven/GraalVM tests | Reference runtime suite; shared guest-admission adapter intentionally absent |

A successful source-free canary on a different GitHub organization demonstrates
runner capacity **only**. It does not establish authorization to export private
Oreslang source. Private-source transfer remains forbidden unless a protected,
independently reviewed source policy approves the exact destination and source
commit/tree. Do not mark no-runner or zero-step jobs as passing, and do not
substitute static policy parity for native compiler and actor/runtime parity.


### Compiler output exhaustion follow-up — October 16, 2026

The prior 1 MiB read limit did not stop a compiler from filling temporary
files *before* the limit was checked. The shared guest-admission subprocess
runner now starts each compiler with bounded stdout/stderr pipes, drains both
concurrently into at most 1 MiB plus a rejection sentinel per stream, and
terminates the compiler on output overflow or timeout. On POSIX it uses a
dedicated process group to cancel related compiler processes. On Windows it
kills the parent process; stronger descendant cleanup requires separate
Windows-native validation. Any invalid UTF-8, NUL, crash, oversized output,
timeout, or partial IR remains a hard failure rather than a valid capability
denial. The mock subprocess tests now patch the bounded runner, while the real
synthetic subprocess tests exercise the output limits and cancellation.

Local exact-file regression evidence: 23 guest-admission tests and 16 policy
tests passed (39 total), including sustained stdout flood, stderr flood,
simultaneous dual-stream flood, hung subprocess and valid/negative synthetic
compiler paths. Native source compiler and actor runtime parity remains
unverified until independently authorized exact-head runner execution.
