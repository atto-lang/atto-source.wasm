# Manual compiler-backed AttoLang Wasm release gate

The private LLVM-to-Wasm workflow is **inert until** it has been merged
into protected `main` and an independent reviewer has approved an
immutable LLVM compiler SHA in
`.github/atto-core-approved-llvm-head.txt`.

The initial approval file contains `NO_APPROVED_LLVM_SHA` intentionally:
this means no private compiler build is authorized yet. To authorize a
reviewed source revision, replace the entire file with exactly the reviewed
40-character lowercase Git head on a separate, independently approved
protected-main change. Do **not** approve an arbitrary user input, moving
branch or synthetic merge ref. The workflow verifies the input SHA equals
the checked-out, protected-main approval file **before** accessing private
source credentials. Token checkout does not persist credentials.

A default-branch `workflow_dispatch` execution is not a PR-head run:
the Wasm tree is the actual dispatched default-branch SHA and receipt must
reflect that identity. Reviewers must also inspect the LLVM source tree,
compiler binary digest, guest output and negative rejection tests.

Source-only PR CI, failed runner admission, or a manual invocation on a
feature branch is never proof of real Wasm guest parity.

## Mandatory repository branch-protection gate

The source repository's GitHub `GET /repos/.../branches/main` currently
reports `protected=false`. The workflow now **queries branch metadata during
the job before referencing private checkout credentials** and denies execution
unless GitHub returns `protected=true` for this repository's `main`.
Main is not made protected by modifying workflow YAML; an authorized GitHub
administrator must configure and verify the actual required reviews/checks,
including protection from unauthorized bypass. Even an affirmative
`protected=true` is **necessary but not sufficient**: independent source
SHA approval, read token authorization, exact-head credentials and executed
step receipts remain separate mandatory gates.
