# atto-source.wasm — browser Wasm guest admission (experimental)

This repository now includes a small, executable preflight and packaging utility for AttoLang browser tenant guests:

```js
import { package_browser_guest } from './src/guest-admission.mjs';
const {wasm,manifest} = await package_browser_guest(compiledRustGuestBytes);
```

The utility verifies actual WebAssembly bytes with `WebAssembly.validate`, rejects unexpected/non-function host imports, checks for `main` and a consistent `actor_init`/`actor_receive` export pair, requires actor memory export and emits a SHA-256 manifest. The output is intended for the per-tenant worker host in [atto-browser](https://github.com/atto-lang/atto-browser), with the `atto.browser.tenants.v1` envelope and existing Rust guest ABI `atto.browser.guest.v2`.

This is an **admission helper, not full Wasm compilation** or a proof that a module is safe. Instantiation-time memory quotas, Wasm fuel/meters, browser-specific resource limits, compiler-generated actor metadata validation and full guest conformance remain work to do. The host itself must still enforce capability authorization and tenant isolation. Browser workers are one per tenant, not one per actor.

Run `npm test` (Node 20+). Host-level tests validate a real Wasm fixture returning 42 and reject bad modules; genuine Atto-compiled actor/browser E2E and multi-backend parity remain unverified.
