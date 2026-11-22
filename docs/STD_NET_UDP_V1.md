# std.net.udp — datagram module, stage 1

**Status:** native `.atto` admission and queue-budget sources; a backend-specific host socket candidate exists, but **guest `std.net.udp` binding is still unlinked and unverified**. Keep this repository's implementation independently owned. There is no requirement to import the module source from `atto-common-source` or match another compiler byte-for-byte.

## Public application API target

```atto
import * as udp from "std.net.udp";

// Illustrative future API; not yet accepted/linked by this backend.
let socket = await udp.bind(udp.endpoint("127.0.0.1", 0));
defer socket.close();
await socket.send_to(bytes, udp.endpoint("127.0.0.1", 9000));
let received = await socket.recv_from(2048);
// received: Datagram { bytes: OwnedBytes, source: Endpoint }
```

- `bind(endpoint, options?) -> Result<UdpSocket, UdpError>` opens a capability-checked, owned socket. Port 0 means OS-selected local port; `local_endpoint()` observes the assigned port.
- `send_to(bytes, peer) -> Future<Result<void, UdpError>>` sends one **whole** datagram or fails. Empty datagrams are allowed. Never silently split datagrams, auto-retry, or claim delivery acknowledgement. Reject destination port 0.
- `recv_from(max_bytes) -> Future<Result<Datagram, UdpError>>` preserves packet boundary and source address, including zero-length successful datagrams. Truncation is an explicit error, not a successful short read.
- `recv_stream(options?) -> Stream<Result<Datagram, UdpError>>` supplies actor-friendly datagram streaming with **bounded queue and backpressure policy**. UDP itself cannot backpressure remote senders; overflow must have an explicit drop/report policy.
- `connect(peer)` is an optional local peer filter/default address and **is not a reliable transport handshake**. `recv_from` never implies reliable delivery, ordering, or exactly-once delivery.
- `close() -> Result<void, UdpError>` is idempotent and releases OS handle once. Concurrent `send_to`, `recv_from`, stop, and cancellation must settle once with no double-close, use-after-close, or leaked actor-owned buffer.
- Broadcast/multicast/group membership, IPv6 dual-stack, DNS, DSCP, hop-limit, socket buffer options, and UDP GSO/GRO require separate explicit capabilities/features; do not expose by ambient authority.
- Existing AttoLang `_blocking` suffix rules apply if a synchronous facade is added; native sockets must use non-parking async operations beneath the facade.
- AOT support means all adapter calls, endpoint layouts, owned buffers, and error variants are statically resolvable; never require runtime code generation.

## Capability, transport and ownership requirements

The host primitive (not the .atto policy helper) MUST check NETWORK permissions at bind, send and receive, including address/range admission and revocation; it must not trust a guest-provided boolean declaring itself permitted. Enforce quotas before buffer allocation. Resolve names in the trusted host with DNS permissions and rebinding protection, or require explicit validated IP endpoints. IPv4 and IPv6 family selection is explicit; no IPv6 jumbogram support in this first stage. An IPv4 payload cannot exceed 65507 bytes and ordinary IPv6 payload cannot exceed 65527 bytes; path MTU may be substantially smaller. `EMSGSIZE`, `EADDRINUSE`, `EACCES`, `ENOBUFS`, `ECANCELED`, closed socket and truncation need typed, non-ambiguous errors.

One actor owns a mutable `UdpSocket` handle. A datagram's `OwnedBytes` may be moved via `take!` to another actor if `Sendable`, or copied explicitly; never create untracked cross-actor aliases to a receive buffer. A borrowed packet must not outlive its owning receive or cross an await without a pinned lifetime. A pinned pending receive owns its buffer until completion/cancellation. Receive stream overflow must be observable; no unbounded mailbox ingestion.

## Implemented source slice

`stdlib/net/udp.atto` contains `udp_address_family_valid`, `udp_bind_port_admissible`, `udp_peer_port_admissible`, `udp_protocol_payload_limit`, `udp_send_payload_admissible`, `udp_receive_capacity_admissible`, `udp_datagram_complete`, `udp_queue_can_enqueue`, and `udp_hop_limit_admissible`. These are pure AttoLang admission helpers, not permission checks, socket wrappers, or substitutes for operating-system error handling.

`tests/fixtures/udp-policy-main.atto` provides 41 positive/negative/boundary decisions, returning 42 on full success. It must be **compiled and executed as guest source** alongside the library source. Text matching, host model execution, and not-started CI are not guest proof. If import linkage is not available, record that limitation rather than treating the example API as implemented.

## Next executable stages

1. Add `std.net.udp` import mapping to this compiler's own source tree; implement a minimal trusted socket ABI with capability checks, handle generations, timeouts, cancellation, owned receive buffers, typed errors and teardown.
2. Execute genuine `.atto` IPv4/IPv6 loopback send/receive, zero-length payload, back-to-back message framing, truncation and timeout; negative tests for permission, invalid endpoints, close/cancel races, buffer/queue exhaustion.
3. Verify native AOT and target-specific support independently. For browser Wasm, raw UDP is **unsupported** unless an explicit authorized host bridge exists. Node and WASI capabilities must be tested separately; do not simulate UDP with WebSocket/WebRTC.
4. Capture exact head/tree/compiler artifact and stepful CI evidence before claiming conformance. Do not mirror private source across organizations without independent authorization.

## Stage-2 Node-only host implementation (2026-11-22)

`src/host-udp-node.mjs` provides a **Node-only trusted-host** UDP adapter backed by `node:dgram` with explicit authorize callback, IPv4 loopback-only bind/send/receive, packet and byte-bounded receive queue, observable drops, async `recv_from` cancellation, and an `recv_stream` async iterator. It snapshots outbound bytes with the existing fail-closed `snapshotGuestBytes` implementation; received datagrams are copied into caller-owned arrays. `tests/udp-host-node.test.mjs` contains real Node loopback cases.

Local Node 22 tests: **4/4 passed** with the exact GitHub blob for the new host code and its test and the existing real `snapshot-guest-bytes.mjs` helper. This is **Node host test execution, not Wasm guest execution**. Browser Wasm has no raw UDP API; browser import must remain denied. No `std.net.udp` guest import mapping has been installed, nor any sanctioned Node/WASI actor capability-token bridge.

## Stage-3 broader compiler parity and regression tests

The backend-owned `stdlib/net/udp.atto` now includes `udp_stream_can_enqueue`, `udp_stream_can_release`, `udp_dropped_next`, and `udp_send_to_admissible`, with packet-count+byte-budget checking and safe saturating drops. Additional `tests/fixtures/udp-boundary-adversarial.atto` covers 41 independent high/low boundary cases, including i64 near-maximum queue values. Combined with the original 41-case fixture, there are **82 positive/negative pure-policy assertions** per backend.

`tests/udp-policy-source-model.test.mjs` contains a retained, runnable Node 22 BigInt source-model harness: `node --test tests/udp-policy-source-model.test.mjs`. It also checks 2,048 independently generated argument sets against a separately implemented mathematical reference for five methods, and checks that mutating queue-bound logic changes behavior. The test is source-translated via Node VM, NOT a compiler, linker, AOT binary, or .atto guest execution receipt. The `udp_stream_budget.atto` stateful class fixture still awaits real compiler parse/typecheck.

An initial source-model evaluation returned 42 on both 41-assertion fixtures for each of nine independently owned `atto-source.*` repositories; the differential oracle also reported 10,240/10,240 checks against the Java branch's concrete UDP policy source. This is not evidence that the nine backends have executable guest parity. In particular `atto-source.hdl` does NOT offer real UDP sockets.

Java, LLVM and .NET host-specific tests cover physical socket pathways in their own source trees; JS/Node and Wasm/Node host adapters also have additional negative tests for close cancellation, receive permission revocation and denied-destination ordering before inspecting untrusted data. All new host tests need exact-head executed runner receipts before being called passed.
