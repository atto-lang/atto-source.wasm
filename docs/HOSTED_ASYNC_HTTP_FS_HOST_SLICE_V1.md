# Tenant-scoped HTTP and virtual filesystem host adapter (v1)

**Status: HOST_TESTED_ONLY. There is no compiled Atto guest execution.**

The new [runtime/hosted-io-v1.mjs](../runtime/hosted-io-v1.mjs) is a development-stage, **unwired host adapter**, not an Atto guest standard-library implementation. It does not alter the compiler, Wasm import allowlist, production guest worker or zero-host-I/O profile. Its exported authority issuer must stay in a trusted host controller, never in guest import options.

Normative future public APIs and evidence:
- [atto-spec #117](https://github.com/atto-lang/atto-spec/pull/117)
- [atto-common-source #29](https://github.com/atto-lang/atto-common-source/pull/29)
- [atto-platform-conformance #101](https://github.com/atto-lang/atto-platform-conformance/pull/101)
- [atto-compilers-parity-testing #19](https://github.com/atto-lang/atto-compilers-parity-testing/pull/19)

## Implemented and locally testable

1. Real HTTP GET against **explicitly granted numeric IPv4/IPv6 loopback origins only**, with exact-origin admission, redirect denial, no cookies/referrer, timeout, bounded body streaming and strict UTF-8 decoding. No external hostnames or ambient DNS privileges.
2. Tenant-private, memory-only virtual filesystem (VFS) with independent READ/WRITE permissions, relative paths, traversal/absolute path denial, byte/file quotas, and all-or-nothing in-memory overwrite. This is **not** Node disk or user host-disk access and is not durable.
3. Host-issued opaque, incarnation-fenced actor grants. A token stolen from another tenant or a retired actor is rejected. Revocation aborts pending HTTP requests. Logical requests settle promptly, while an abort-ignoring transport retains its physical concurrency slot until it unwinds.
4. Actual host HTTP → text → tenant VFS write → read → exact text/UTF-8 byte verification, plus cancellation, no-ambient-authority, 404, redirects, oversized content, invalid UTF-8, stale token, quota and path negatives.

## Local verification

Requires Node 22+ and no external network access:

    node --test tests/hosted-io-v1.test.mjs

The file is also picked up by the existing npm test wildcard. The test runs a local HTTP server on a random loopback port. The original source and 11 host tests passed locally on Node 22.16.0. This is **host-only** evidence, not a GitHub Actions or compiled Atto guest pass. Rerun exact-PR-head tests and require independent review before merging.

## Not yet implemented

- Native .atto std.http / std.fs modules, import linking, real compiled source execution, Error/Result and susp/await translation.
- Authenticated Wasm request/resume ABI bound to guest memory and actor generation. Integrate [atto-source.rs #386](https://github.com/atto-lang/atto-source.rs/pull/386) and [#186](https://github.com/atto-lang/atto-source.rs/pull/186) rather than duplicating them.
- Persistent origin-private or mounted browser filesystem. No OS fs handle, symlink/TOCTOU protection for a real external root, or native filesystem provider is claimed.
- Production HTTP client to non-loopback hosts: DNS resolution/address checks, TLS, redirect reauthorization, decompression/header budgets, full protocol framing and secure transport cancellation policy.
- Compiled guest tests across the 11 atto-source backends, including a true HTTP → FS roundtrip, exact-head receipts, failure cases and independent CI verification.

**Release gate:** Do not wire this host object to untrusted Atto/Wasm until the typed capability grant, memory-boundary validation and guest compiler's asynchronous continuation lifecycle are independently verified. All backend guest parity remains NOT_EXECUTED.

## Extended host-only filesystem API (2026-11-22)

`runtime/hosted-io-v1.mjs` now implements real **memory-only tenant VFS** behavior for:

- file bytes: `read_file`, `write_file`, `append_file`, `copy_file`, `rename`, `remove_file`
- directories: `create_dir`, `create_dir_all`, `read_dir`, `remove_dir`, `remove_dir_all`
- metadata: `metadata`, `exists`, `is_file`, `is_dir`, `file_size`
- affine handles: `open` options, per-handle `read`, `write`, `flush`, `close`
- bounded stream handles: `read_stream` with `read_chunk`/EOF and `write_stream` with `write_chunk`, `flush`, `close`
- pure path helpers: `FsPath`, `FsPathBuf`, `path_join`, `path_parent`, `path_file_name`, `path_extension`, `path_normalize`

Capabilities are host-issued opaque actor-incarnation tokens with independent
`read`, `write`, `directories`, `remove`, and `recursive` booleans.
Root listing is read-only via `"."` or `"./"`; root deletion/rename is
forbidden. Nested creation is preflighted against directory quota; file
mutation uses defensive byte copies and size accounting. Directory listings
are sorted by Unicode scalar value. Handle quota, stale/closed handle rejection,
actor-restart fences and read/write permission checks are enforced by the
adapter. `flush` only completes memory-buffer operations, never promises
host-disk durability. No symlinks, devices, arbitrary mounts or external
process filesystem access exist in this VFS.

All exported JS host types/methods are **host-only adapter equivalents**.
They are not compiler-linked Atto `Path`, `File`, `FileStream`,
`OpenOptions`, `FsError`, `Result` or `susp` lowering. The API target
lives at [atto-spec #117](https://github.com/atto-lang/atto-spec/pull/117).
The independently owned `.atto` policy candidate lives in
[Wasm source PR #270](https://github.com/atto-lang/atto-source.wasm/pull/270)
and **is on a separate branch** from this host adapter; neither makes
`import * as fs from "std.fs";` executable yet.

Verification: 31 in-process V8 host smoke scenarios ran successfully in the
editing environment using ASCII-only text shims, exercising file/dir/handle/
stream, root, quotas, denial, stale token, and path constraints. New exact-head
Node 22 tests (nine groups) are authored in `tests/hosted-fs-api-v1.test.mjs`, included by
`npm test`, but are **NOT_EXECUTED** on this head until a real Node job runs.
The earlier 11 historical Node host tests must be re-run against the new code;
compiled Atto guest checks remain **NOT_EXECUTED** on every backend.


**Error mapping:** Host-only `FsError` is a subtype of `HostIoError` with stable `FsErrorKind` mapping for `E_FS_*` statuses. Generic host/actor permission or cancellation statuses still require typed *operation-aware* mapping in the unimplemented Atto guest boundary; they are not yet Atto `FsError` objects. The nine authored Node test functions passed in isolated V8 with an ASCII encoding/assert shim, which is **not** Node or CI execution.
