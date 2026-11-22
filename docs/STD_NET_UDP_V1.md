# std.net.udp — datagram module, stage 1

**Status:** native `.atto` policy implementation and guest regression fixture; **socket API not linked or claimed executable**. Keep this repository's implementation independently owned. There is no requirement to import the module source from `atto-common-source` or match another compiler byte-for-byte.

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
