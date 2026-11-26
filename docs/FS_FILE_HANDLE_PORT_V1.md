# Actor-scoped File handle port v1 (host-only integration)

The `std.fs.File` guest API must be an affine, actor-owned type. A caller
may pass the same typed `File` instance directly to `fs.read_text(file)`,
`fs.write_text(file, text)`, `fs.read_file(file)`, and
`fs.write_file(file, bytes)`, without constructing a `FileStream`.
Example: [fs_file_instance.atto](../examples/atto/fs_file_instance.atto).

**Current scope is strictly host-only.** The privileged
`runtime/fs-file-handle-port-v1.mjs` exports
`ActorFileHandlePortV1`, which encapsulates a real host File object
and the authenticated host-issued actor ticket. It returns an integer
handle to a trusted dispatcher, not the File object or actor ticket.
This is *not* a registered Wasm import, an Atto compiler intrinsic, a
linked `.atto` File class, a native AOT filesystem driver, or a working
guest suspension/continuation ABI.

## Host port operations

```js
// All of this code runs in the trusted host, never untrusted Atto guest code.
const actorTicket = vfs.open_actor(7, 1, {read:true, write:true});
const port = new ActorFileHandlePortV1(vfs,actorTicket,
  {maxOpen:64,maxIssued:4096});
const id = await port.open('data/file.txt',
  {read:true,write:true,create:true,truncate:true});
await port.write_text(id,'Hello');
await port.seek(id,0);
const text = await port.read_text(id); // "Hello"
await port.close(id);
await port.close(id); // idempotent cleanup for a previously issued ID
await port.close_all();
```

Import the host port class from
`runtime/fs-file-handle-port-v1.mjs`. Do not pass `port`, `actorTicket`
or host File closures into guest memory. Only a *trusted runtime
dispatcher* may translate a guest's numeric File ID into a call on this
actor's private port.

### Security/ownership and cancellation

- Numeric IDs are actor-port-relative positive safe integers, never
  reused within a port, even after failure. Failed opens are **not
  issued**. Unknown/forged IDs fail `E_FS_HANDLE` (kind
  `invalid_handle`), issued-then-retired IDs fail `E_FS_CLOSED`,
  except `close(id)`, which is idempotent for an issued closed ID.
- `maxOpen` bounds active and pending opens. `maxIssued` bounds
  lifetime numeric IDs; issuing a new ID never resurrects an old one.
- Every read/write/seek/flush/close is single-flight per file. A
  concurrent operation fails `E_FS_BUSY`. The port stores File objects
  privately and reuses the same cursor; `read_text` reads to EOF and
  does not close or implicitly truncate.
- The port rechecks the host actor ticket **after awaited I/O** before
  returning success. A revoke/restart during read/open cannot publish a
  successful result, even when the host side effect already happened.
- `close_all` denies new operations, waits for existing operations,
  closes pending newly opened File objects and retires outstanding handles.
  A cancelled write outcome is uncertain: **no automatic retry or rollback**.
- These guards are not an OS sandbox. Actual disk access, symlink race
  resolution, untrusted worker boundary and guest borrow-check enforcement
  require separate compiler/runtime implementation.

## Test evidence and gaps

The new `tests/fs-file-handle-port-v1.test.mjs` contains **19 tests** for
actor scope, open/issued budgets, race handling, byte/text cursor,
mode permissions, stale actor admission, idempotent close, and
structured shutdown. Existing `tests/hosted-fs-api-v1.test.mjs` has 24
host VFS test groups. Both backends passed **43/43 under an isolated
JavaScript V8 ASCII/assert shim**. This is NOT a Node 22 GitHub Actions
receipt, Unicode/invalid-UTF8 conformance or a compiled Atto guest test.

Exact source/test hashes and runner status are recorded in
[atto-platform-conformance #101](https://github.com/atto-lang/atto-platform-conformance/pull/101)
(`contracts/hosted-fs-file-handle-port-v1.json`). Source-local
`.github/workflows/std-fs-file-handle-host-v1.yml` checks the exact SHA
and runs both test files on Node 22 when Actions admit an actual runner.
No private source was transferred to another organization. Such a
mirror remains gated by [security review #286](https://github.com/atto-lang/atto-source.wasm/issues/286).
