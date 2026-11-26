# Atto `std/io` (source milestone)

Import name: `std/io` (or `atto.std/io` when disambiguation is needed).
The implementation lives in the owning compiler repository, not in a shared cross-compiler source dependency.

This phase provides **Atto-native in-memory I/O**:
`io.Cursor` supports bounded `read`, atomic `read_exact`, `seek`, and explicit EOF.
`io.Sink` supports partial `write`, atomic `write_all`, `snapshot`, and `close`.
`io.BytePipe` is a one-owner bounded FIFO with `try_read`, `try_read_exact`,
`try_write`, `try_write_all`, and writer half-close.
`io.ReadChunk` distinguishes data from an EOF marker. Empty open-pipe reads are
`Err("WouldBlock")`, **not EOF**. Limits are measured in bytes; octets must be 0..255.

A `try_*` method is synchronous and strictly in-memory; it never parks a carrier,
polls an OS handle, or reads from stdin. It is intended as a building block for the
default **asynchronous** `read()`/`write()` operations on hosted readers/writers.
Those adapters still need actual compiler/runtime support for Futures, cancellation,
ownership of handles, fairness, wake-up notifications and error mapping.
**This milestone is not a working filesystem/socket/stdin provider.**

Failure behavior: invalid bytes are rejected before *any* partial write; failed
`*_exact` calls preserve the current position/queue; `write` may short-write
and returns the committed byte count; an exhausted open pipe reports
`WouldBlock`; a closed, drained pipe reports EOF; queued data remains readable
after writer half-close. `Cursor` and `Sink` snapshot and own byte arrays.

Run the source-contract/reference-model tests:
```sh
node --test tests/std_io_contract.test.mjs
```
These tests **do not execute the Atto compiler or guest**. Native compile, guest
execution, negative ownership fixtures and actual async provider tests are
separate acceptance gates; do not mark them green based on this source-only test.
