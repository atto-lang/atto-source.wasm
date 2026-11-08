# Real Rust compiler source actor local receipt — 2026-11-08

**Status: local non-publishing characterization, NOT exact-head CI or public Chromium parity.** No compiler binary, guest binary or private source was committed to the Wasm repository or deployed to Pages.

## Compiler and artifact

- Source: `atto-lang/atto-source.rs` PR #25, head `4ad482784142cfa9625efe0c6ed48f4a8b002ffe`, artifact receipt tree `1109fe42e193a81eacbe5ed39a14a50838a68b97`.
- Compiler workflow run `42416212246` executed **14** real `real-compiler` job steps and uploaded artifact `atto-compiler-wasm32-4ad482784142cfa9625efe0c6ed48f4a8b002ffe`.
- Local compiler binary: **201,697 bytes**, SHA-256 `a7a783762e57ea2dd32237fc5e3612f1b12e3e558edd7accd604c293d947791d`. Target wasm32-unknown-unknown, zero host imports, compiler ABI `abi_version()==2`.
- **Receipt discrepancy:** artifact declares `guest_abi: atto.browser.guest.v1` despite the actor-enabled guest exports. Do not treat this as permission to publish a new guest ABI version or replace the pinned public `/play/` compiler. Require independent release/version review.

## Source and real guest execution

The actual Rust compiler-as-Wasm compiled:

```atto
define actor Worker as receive(msg: int) -> int { return msg + 1; } end
pub fnc main(): int {
  val first = spawn Worker();
  val second = spawn Worker();
  return 0;
}
```

- Actual `compile()` returned **0**, producing **531 bytes** of guest Wasm with SHA-256 `cc19e3fbca791b46280bd0cd123695fabb7a30d4d6b45b56f194b87da4602948`.
- Node 22/V8 `WebAssembly.validate` and `WebAssembly.compile` accepted the guest; it imports only `atto.actor_spawn`, exports `main`, `panic_code`, `atto_actor_receive_0`.
- Two independent guest `WebAssembly.Instance` objects produced 42, 43, 44 on input messages and had distinct exported mutable globals. **This scalar guest has no linear-memory section**: no actor-owned heap or bounded stack proof is claimed for it.
- The exact PR #442 `inspectAttoActorAbi` and opt-in no-managed scanner accepted the **real 531-byte guest** via a local JS parser harness; engine validation was separately executed in Node.
- A separate local Node `worker_threads` test harness ran this compiler-produced guest in **two tenant Workers** with two instances in tenant A and one in tenant B. It observed **13 successful protocol receipts**, including state isolation, restart, stale-generation rejection and intact neighboring actors/tenant. **This is a standalone local harness, NOT an exact-head PR #442 runtime test.**
- Parent supervisor mock tests in V8: **10/10**; ABI parser positive/negative tests **10/10**; no-managed scanner **4/4**. These are local characterizations rather than hosted GitHub CI or source-compiler parity suites executed from a checkout.

## Unverified release gates

- Chromium DevTools and WebSocket launched locally, but its navigation to the loopback test server displayed an organization policy block for 127.0.0.1; actual local Chromium actor E2E **BLOCKED / NOT_EXECUTED**.
- PR #442 workflow jobs at its previous head had `steps=null` and are **runner admission failures**, not test failures or passes. The new opt-in reviewed-compiler Node/Chromium suites are staged but have not produced executed exact-head receipts.
- No private compiler binary or source was mirrored into the Wasm repository; these findings are a separate local test receipt.
- Missing: independent compiler artifact/source review, correct ABI receipt labeling, compiler-managed bounded stacks and continuations, CPU scheduling/quotas, real Chromium executed exact-head fixtures, separate tenant failure tests, and public release authorization.

See `docs/BROWSER_TENANT_WEBWORKER_V0.md`, `tests/browser-atto-compiler-parity.mjs`, `tests/browser-atto-compiler-chromium.mjs`, source CI issue #447, and Rust compiler acceptance issue at `atto-lang/atto-source.rs#41`.

**Keep PR #442 DRAFT. Do not publish a compiler artifact or upgrade the public `/play/` compiler receipt without independent approval.**
