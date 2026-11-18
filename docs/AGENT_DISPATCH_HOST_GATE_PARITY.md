# AI agent model dispatch: fail-closed host gate (v1)

**Backend:** oreslang-source.wasm. **Evidence class:** HOST-ONLY; **native Oreslang guest parity: NOT VERIFIED**.

This contract supports the AI-agent coordination demo's signed-context/data-only
dispatch and one-shot durable effect fencing. A model response, repository text,
caller-supplied `approved` flag, or signed *context evidence* receipt must
never become a tool/deploy/CI approval.

## Contract

The canonical JSON is `contracts/v1/agent-dispatch/contract.json`, identical
across all five `oreslang-source.*` repositories at this review. It pins:
- Host-issued tenant, actor ID/incarnation, activation epoch, exact Git SHA,
  logical dispatch ID, measured payload SHA-256, bounded bytes and token count,
  and a trusted clock/expiration.
- An independently controlled `authorize` callback that validates scope,
  authority, revocation, signer and permissions. The gate **does not implement
  signature verification or capability issuance**. Never delegate that
  callback to the guest or a prompt-controlled document.
- A **durable atomic** one-shot `claim_once` implementation, keyed by the
  logical dispatch identity with immutable payload digest; unknown remote
  outcome remains claimed. The test callback is not a durable backing store.
- Second revision/policy checks **after** claiming, plus an independent trusted
  host-clock check both before admission and after the claim. Zero, missing,
  backwards or expired clocks fail closed even if the caller's original
  timestamp was valid. A claim may remain spent when dispatch is refused.
  The trusted provider must independently enforce authorization, deadline
  and idempotency at its actual dispatch point (host-to-provider TOCTOU
  is otherwise still present).
- Explicit rejection of malformed IDs, stale actor generation/epoch/revision,
  expiry, resource overflow, missing claim/policy, spoofed fields, storage
  errors, and ambiguous remote completion.

No actor may perform I/O while holding a critical state loan. A trusted host
storage/dispatch actor should use an asynchronous mailbox API with detached
sendable messages, opaque capability handles, and no guest-visible signing keys,
native handles, FFI pointers or raw storage connections. Untrusted actors and
VM isolates must not receive the `unsafe` package or these host callbacks.

## Test command

`node --test tests/agent-host-dispatch.test.mjs` (also included in `npm test`).

**Current evidence:** Local Node 22 TAP: 5/5 host contract tests passed on the exact source/test bytes. No WebAssembly guest imported privileged services.

These exercises are admission-substrate tests, not proof of durable multi-host
recovery, actual Ed25519 issuer verification, real tokenizer quotas, external
provider idempotency, actor-owned arenas, `handle_state` lowering, Java/Graal
JDK25 guest oracles, LLVM guest codegen, WASM/NET/Forge native guest execution,
or five-backend runtime parity.

## Required native release proof

1. Keep the compiler fail-closed until sealed actor state and borrow/effect
   checking are actually supported, with negative diagnostics showing the
   expected specific error (not a generic parse failure).
2. Implement a host-owned issuer + revocation service, a storage-enforced
   claim with crash-consistent `unknown` recovery, and independently verified
   provider receipts. Test real SIGKILL before/after a provider effect.
3. Verify exact source/compiler Git tree SHAs, actual executed job steps,
   native compilation, two agent guest oracles, source/borrow negatives and
   actor-generation/tenant isolation.
4. Run the same admission/denial/recovery trace across Java, LLVM, WASM,
   .NET Native AOT and Forge; classify absent support as NOT_VERIFIED or
   explicitly rejected, never as PASS.
5. Preserve the open private-source incident hold: no cross-organization
   Git tree, blob, cache or artifact transfer without separately recorded
   source-owner and destination-owner authorization.

Reference: AI agent demo issues #4, #7, #9 and draft #25; open
`oreslang-platform-conformance#22` is an independent confidentiality gate.
