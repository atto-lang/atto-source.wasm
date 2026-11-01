# Core-Wasm LiveView/WebSocket admission (fail closed)

Current core-wasm.i64-v1 has ZERO host imports, no guest network I/O,
reactor, WebSocket server/client and no actor-based LiveView session.
This change adds explicit `websocketMode` and `liveviewUpdates` denial before
untrusted Wasm compilation, rather than pretending that browser WebSocket
access grants a guest a listener or network capability.

`tests/liveview-websocket-admission.test.mjs` authors 21 negative/positive
admission variants; they are host-only source safety checks, not a real
WebSocket runtime. Exact canonical RFC6455 fixture of 41 vectors is staged
under `contracts/v1/ores-liveview-wire-v1.json` for a **future** authorized
host bridge / Wasmtime or worker adapter, Git blob
`931f58c1acd40e4c7e1b0b061f1711a0afe3c9b8`.

A backend-neutral native parity claim additionally needs a browser/Node-host
capability-aware WebSocket adapter with origin/auth, protocol negotiation,
explicit host<->Wasm ownership, cancellation, bounded backpressure and
compiled Oreslang guest delivery. No such adapter is implemented here.
No private source exported to another GitHub org.
