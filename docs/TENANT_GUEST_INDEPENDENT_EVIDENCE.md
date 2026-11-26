# Independently corroborated tenant guest CI evidence (stacked on #448)

This PR adds **an evidence corroborator, not tenant enforcement**. There are two gates:

1. \`verify-tenant-guest-receipt.mjs\` checks that a self-supplied receipt has a coherent *shape*. It cannot independently authenticate a receipt.
2. \`verify-tenant-guest-evidence.mjs\` independently queries GitHub for exact-head source and run identities, job steps, an explicitly approved immutable workflow, source/carrier blobs, and bytes of a downloaded evidence artifact. It can return \`PROVENANCE_CORROBORATED\`, but **\`enforcement_status\` always remains \`NOT_VERIFIED\`** pending a separate code-level trust boundary review and compiled guest security assessment.

### Trusted independent verification

Run this from a **separate, protected verifier environment**, *not* within the unreviewed pull request or any guest process.

\`\`\`sh
node --test tests/tenant-guest-receipt.test.mjs tests/tenant-guest-evidence.test.mjs
GH_TOKEN=<read-only-verifier-token> node scripts/verify-tenant-guest-evidence.mjs receipt.json independently-reviewed-policy.json
\`\`\`

Do not put GH_TOKEN, a privileged checkout token, or the protected policy inside the untrusted guest workflow. For an inaccessible private source repo, return \`NOT_VERIFIED\`; never drop the source-tree check. An unauthenticated read-only API call is acceptable only when it can actually access all evidence. The structural smoke workflow uses only read-only contents permission, a pinned checkout with \`persist-credentials: false\`, and runs no guest workloads.

The protected JSON policy, supplied by an independent reviewer and **not** accepted from a PR artifact, must contain:

\`\`\`json
{
  "source_repo": "ores-truffle-oreslang/oreslang-source.wasm",
  "source_head_sha": "<40-char exact source commit>",
  "workflow_path": ".github/workflows/tenant-evidence.yml",
  "workflow_id": 123,
  "approved_workflow_sha256": "<64-char independently reviewed workflow file hash>",
  "carrier_repo": "<optional approved private carrier>",
  "carrier_head_sha": "<required exact carrier commit when carrier_repo differs>"
}
\`\`\`

A successful real compiled-guest job must have these **executed** and successful GitHub steps:
- \`Verify source blob parity\`
- \`Compile AttoLang guest\`
- \`Execute two-tenant guest\`

These names are neither evidence by themselves nor a substitute for protected workflow identity. Review the workflow byte hash and its commands, compiler invocation, runtime isolation, broker authorization checks, quota accounting and captured execution before promoting any claim. A workflow under review can otherwise simply print fake receipts.

The unique unexpired GitHub Actions artifact must be named \`tenant-guest-evidence\`. GitHub's archive digest must match downloaded ZIP bytes. ZIP must contain four bounded, unencrypted top-level entries:

| ZIP entry | Proof requirement |
| --- | --- |
| \`source.atto\` | SHA-256 matches the receipt's compiled guest source |
| \`compiler.bin\` | SHA-256 matches the compiler artifact; not merely a package name |
| \`guest.bin\` | SHA-256 matches the compiler-produced guest binary |
| \`execution.json\` | Binds exact run/source/tenant identities to the mandatory five case results |

The protected verifier independently checks every repository blob entry against its corresponding carrier version, except the *one* explicitly approved carrier workflow path. Carrier copy must remain private; do not export private source to public repositories. Git tree truncation, artifact list/job pagination, missing exact-head SHA, unknown workflow byte hash, missing results or inaccessible GitHub read evidence all fail closed. This is not a runner provisioning tool and does not require writing to the source organization.

### Required guest scenarios

The machine-readable contract is \`contracts/two-tenant-guest.v1.json\`, with the five cases required for **all five** backends: Java/GraalVM, LLVM, Wasm, Forge and .NET.

- Aggregate quota survives actor restart, descendant creation and tenant incarnation changes.
- Revocation between admission and dispatch denies the send and refunds credits once.
- Forged/stale ActorRef and replayed broker tickets fail before foreign-resource resolution.
- Explicitly authorized broker send delivers one cross-tenant DATA message.
- Unrelated tenant B continues making progress despite A's exhaustion/failure.

The actual fixture must compile AttoLang source, execute isolated tenant guests, call a host-authenticated broker, and inspect authoritative effects. Neither synthetic JSON nor Node tests nor host C/JVM/.NET/Wasm reference-only enforcement qualify. For JVM/GraalVM and Wasm, guest compiler/runtime paths are the starting integration targets. LLVM and Forge additionally require actual native containment; .NET must exercise NativeAOT guest dispatch.

### Readiness and limitations

**NOT VERIFIED:** No real two-tenant compiler-produced execution, no independent protected workflow pin, no actual carrier execution receipt, and no OS/process containment claim are introduced by this PR. The positive local tests use deliberately synthetic API, ZIP and step fixtures only. The GitHub smoke workflow, if admitted, proves only that Node test cases run. No merge or production security promotion should follow from a positive synthetic test or provenance gate alone.

When the source organization's Actions fails before job steps, use a private approved carrier only after *exact* source blob parity and trusted workflow identity checks. Report zero-step jobs as \`NOT_EXECUTED\`, never pass.
