# Trusted TenantVM multi-actor Wasm vertical slice (2026-11-11)

**Scope:** experimental **trusted host only**. This is **not** certified
untrusted TenantVM isolation, not the Wasmtime native tenant Store runtime, and
not production actor/supervisor parity. The host accepts only approved Wasm
actor modules with the existing strict import-free, memory-bounded scalar ABI.

## Actual structure

- One trusted Node Worker carrier (and one PooledWasmActors instance) per
  TenantVM generation, rather than pooling unrelated tenants together.
- Within that dedicated carrier, up to the configured bounded actor count.
  Every actor is a separate WebAssembly.Instance with private fixed 2-page
  linear memory and its own checked i64 on_message state.
- The trusted host issues opaque, identity-checked TenantVM and actor tokens.
  Caller-supplied tenant IDs alone cannot authorize a guest turn.
- New actor reservations count against both tenant and OresVM-host ceilings,
  **before** waiting for asynchronous initialization.
- send_actor / stop_actor require both the owning TenantVM token and the
  exact actor token. A cross-tenant or stale token is rejected.
- close_tenant_vm seals admission, requires the pooled carrier's physical
  Worker.terminate() receipt, then releases tenant actor reservations and
  permits a new generation. Unconfirmed termination quarantines the existing
  tenant ID and retains reservation authority.
- A spinning / trapping actor causes the tenant's dedicated carrier to be
  retired; other tenants have distinct Workers. One scalar turn runs at a time
  inside a tenant Worker in this stage, which **does not** meet the eventual
  within-tenant parallelism target.

## Gates

Host/actual Wasm but NOT AttoLang compiler-backed:

```sh
node --test tests/trusted-tenant-vm-host.test.mjs
```

The host tests link a hand-authored LLVM IR actor fixture to actual WebAssembly.
They verify two tenants, three actors each, private actor state, generation
fences, cross-tenant rejection, aggregate actor quotas, independent retirement,
and a busy-loop termination. They must not be reported as compiled .atto proof.

Real AttoLang source actor compilation, 6 actors / 2 TenantVMs:

```sh
export ORESLANG_LLVM_COMPILER=/absolute/path/to/oreslang-llvmc
export ORESLANG_LLVM_COMPILER_SHA256=<exact-sha256-from-verified-build>
npm run test:real-tenant-vm
```

The mandatory script fails if a compiler or pin is missing. The fixture is
`tests/fixtures/tenant-vm-counter.atto`, compiled by the existing real LLVM
source-actor wasm32 bridge. It requires independent compiler-source
commit/tree verification; self-reported SHA-256 **does not authenticate code**.
Normal `npm test` may skip this gate if the compiler is unavailable; a skip
is explicitly **NOT_EXECUTED**.

## Audited quiescence and quota-retirement race (2026-11-11)

The original host's per-actor release path could refund a reservation while
a TenantVM was already quiescing, before its Worker termination had been
confirmed. An asynchronous rejected spawn/stop could thereby release aggregate
host capacity to another tenant prematurely. The hardening change gates each
individual refund on a running tenant **and** one live carrier; quiescing,
stopped or quarantined tenants retain *all* remaining reservations until
`close_tenant_vm` observes physical termination. Reconciliation also rejects
aggregate counter underflow and unexpected tenant registry changes.

A dedicated real-Worker regression test withholds `Worker.terminate()`
confirmation and verifies: concurrent failed admission cannot refund tenant
slots, another tenant cannot exceed the aggregate cap, old tenant IDs remain
reserved until confirmed retirement, and a rejected termination leaves the
incarnation quarantined. Execute it at an exact source head:

```sh
node --test tests/trusted-tenant-vm-retirement-races.test.mjs
```

The source-accurate quota logic passed **3/3 local controlled-transport race
tests**, and those same tests reproduced **3/3 failures** on the old release
logic. Those local tests are deterministic accounting tests, **not** executed
Node Worker termination evidence or compiled AttoLang guest proof. The
real-Worker regression is committed but **NOT_EXECUTED** until a runner records
nonzero steps.

## Critical unimplemented security requirements

The root interface is for a privileged trusted embedder and MUST NOT be
exposed as a guest/network API. An explicit trusted boolean is **not** an
artifact approval signature. A Node Worker on its own does not sandbox
arbitrary untrusted JavaScript, and its process memory / scheduler / native
runtime are not OS-enforced tenant security boundaries.

Production promotion needs validated guest-code provenance, independent
per-tenant enforced resource bounds, authenticated broker authority, multiple
actor supervision/CONTROL channels, I/O-loan drain, fair per-tenant and
within-tenant scheduling, typed messages, reliable cancellation and actor
parallelism, and a verified untrusted TenantVM backend (Wasmtime/Graal
isolate). Existing native Wasmtime tenant Store smoke is a separate scalar
path. Do not merge the two proof categories into one claim.

## CI readiness

As inspected on 2026-11-11, Wasm AOT PR run
43033527052 had **runner_id 0**, no runner name and **0 executed steps**.
This is an Actions runner/admission blocker, not a failed compiler test.
The shared-process conformance backend status remains **NOT_EXECUTED**.
Do not bypass private source approval or mirror a private compiler checkout
to another organization without independent authorization.
