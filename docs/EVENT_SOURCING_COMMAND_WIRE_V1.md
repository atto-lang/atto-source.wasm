# Event-sourced command wire v1 — Wasm host boundary

Status: **host-only codec**, not guest event sourcing.

`src/durable-command-wire-v1.mjs` implements an owned-copy, bounded
big-endian event-batch codec matching the proposed Java/LLVM SQLite command
inbox format (up to 256 events, 64KiB/event, 1MiB/batch, 64KiB request/reply).
`tests/durable-command-wire-v1.test.mjs` checks the two-event canonical
vector, caller-buffer isolation and malformed input rejection.

Wasm's current admitted guest ABI remains pure `() -> i64` with no
guest-host I/O imports or event-sourced actor runtime. This module
does not give a guest a persistence capability and does not attempt to
interpret AttoLang source. A real portable implementation requires
an authenticated per-tenant broker outside the zero-import Wasm guest,
compiler-generated event-sourced actor lowering, durable inbox transactions,
fencing, async actor workers, and a pinned real-compiler wasm32 fixture.

**Evidence class:** Node host unit tests only when actually executed. Compiler
parse/typecheck, emitted wasm guest and five-backend durable actor runtime:
NOT_EXECUTED. Do not copy private sources to an unapproved CI carrier.
