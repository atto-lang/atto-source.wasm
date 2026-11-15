# atto-source.wasm — browser Wasm guest admission (experimental)

This repository now includes a small, executable preflight and packaging utility for AttoLang browser tenant guests:

```js
import { package_browser_guest } from './src/guest-admission.mjs';
const {wasm,manifest} = await package_browser_guest(compiledRustGuestBytes);
```

The utility verifies actual WebAssembly bytes with `WebAssembly.validate`, rejects unexpected/non-function host imports, checks for `main` and a consistent `actor_init`/`actor_receive` export pair, requires actor memory export and emits a SHA-256 manifest. The output is intended for the per-tenant worker host in [atto-browser](https://github.com/atto-lang/atto-browser), with the `atto.browser.tenants.v1` envelope and existing Rust guest ABI `atto.browser.guest.v2`.

This is an **admission helper, not full Wasm compilation** or a proof that a module is safe. Instantiation-time memory quotas, Wasm fuel/meters, browser-specific resource limits, compiler-generated actor metadata validation and full guest conformance remain work to do. The host itself must still enforce capability authorization and tenant isolation. Browser workers are one per tenant, not one per actor.

Run `npm test` (Node 20+). Host-level tests validate a real Wasm fixture returning 42 and reject bad modules; genuine Atto-compiled actor/browser E2E and multi-backend parity remain unverified.

### Browser route v1 contract

The application-controlled route broker in `atto-browser` binds sender and destination tenant generations and authenticates grants. For compiled Wasm actors, remote messages are exactly **8 bytes, signed i64, little-endian**, decoded by the browser host before invoking `actor_receive(i32 type, i64 payload, i64 sequence)` in the destination actor's private Wasm instance. `src/route-wire.mjs` contains the encoding/decoding reference and negative tests. Packaging manifests publish `route_wire: 'atto.browser.route.v1'` and `route_payload: 'i64-signed-le8'`.

This is an external browser transport, **not** a new guest import and not yet compiler support for cross-tenant AttoLang `actor.send` syntax. Transferable `ArrayBuffer` ownership and capability checks are implemented by the browser host. The consumer must still reject unsafe modules and unauthorized routes. The full Chromium route-to-real-compiled-actor test is maintained in `atto-browser`; this package tests its encoding contract, not browser isolation.
