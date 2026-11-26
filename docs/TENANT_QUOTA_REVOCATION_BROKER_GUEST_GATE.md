# Tenant quotas, capability revocation, brokered actor sends: guest receipt gate

This is a **read-only receipt-shape verifier**, not an enforcement implementation or independent attestation. A self-reported receipt can lie. Review GitHub run/job metadata, executed step logs, source/guest artifact SHA identities, and source-tree/approved-carrier manifests independently.

## Run

- Structural tests: node --test tests/tenant-guest-receipt.test.mjs
- Check a receipt: node scripts/verify-tenant-guest-receipt.mjs /path/to/receipt.json
- No tokens, network, source export, or repository writes.
- Zero-step Actions failure means NOT_EXECUTED, not a test result.

## Smallest actual guest proof

Compile source actors A and B under independent trusted tenant incarnations. The trusted broker (not an ID claimed by a guest) must bind producer, route, capability, policy and supervisor lineage.

1. tenant_aggregate_quota_survives_restart: consume tenant quota, restart an actor or create descendants, and verify the quota does not reset. Include bytes/outstanding admission and CPU or memory envelopes.
2. revoked_capability_denied_at_dispatch: revoke after initial admission but before dispatch; deny and settle reserved credits exactly once, even during cancellation.
3. forged_cross_tenant_actorref_denied: submit a foreign, stale or replayed ActorRef/broker ticket; deny before resolving any foreign resources.
4. authorized_broker_delivery_exactly_once: explicitly authorized cross-tenant DATA message delivered once with safe serialization/ownership.
5. unrelated_tenant_survives_denial: isolate failures and exhaustion to A while B continues operating.

All five cases must execute compiler-produced guest calls under an authenticated broker. Host-unit tests, hand-assembled Wasm, synthetic receipts and static code review are not guest proof. Record exact source commit, compiler and executable digests, guest module digest, GitHub job/run and step records, and independently verified source blob matches. No guest-originated CONTROL authorization.

## Backend-specific holds

- Java/GraalVM: host-owned aggregate quota and protected guest broker ingress; a Truffle Context is not proof of OS sandboxing.
- LLVM: genuine compiled .atto guest to broker with OS/process isolation for hostile code; C11 trusted domain IDs alone do not enforce native tenant boundaries.
- Wasm: actual compiled Wasmtime/Wasmi guest, independent stores, bounded aggregate host memory/fuel; Node workers do not prove OS isolation.
- Forge: sandboxed native/JIT worker with revocable authority, bounded compilation and guest resource use; no in-process untrusted native execution.
- .NET: NativeAOT compiled guest broker integration, not merely host NativeMemory/checked-offset unit tests.

Staged host-only access-grant drafts currently exist: Java #2679, LLVM #1592, Wasm #445, Forge #233 and .NET #425. None should be promoted as proven guest security solely on this gate.

## Evidence classification

DESIGN_ONLY: proposed behavior.
HOST_REFERENCE_ONLY: tests of trusted host-side primitives.
STRUCTURAL_RECEIPT_ONLY: receipt passed this offline shape validator; authenticity is unverified.
COMPILED_GUEST_EXECUTED: real guest test plus independently checked source, binary, and stepful runner provenance.
ENFORCEMENT_VERIFIED: independently reviewed trust boundary, side effects, transport cleanup and the adversarial cases above. This validator never awards this classification.

Keep untrusted network and cross-tenant default deny in place until positive and negative guest proof, runner attestation and independent security review pass.
