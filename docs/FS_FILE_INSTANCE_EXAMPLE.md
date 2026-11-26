# std.fs File class and File instance overloads

**Public Atto target:** `import * as fs from "std.fs";`

`fs.File` is an affine class returned by `fs.open`. A File **instance** can
be passed directly to the module-level `fs.read_text`, `fs.write_text`,
`fs.read_file` and `fs.write_file` helpers. No `FileStream` is necessary.
See [the Atto source example](../examples/atto/fs_file_instance.atto) and
[atto-spec #117](https://github.com/atto-lang/atto-spec/pull/117).

Representative File class contract (API sketch, **not** a linked compiler class):

```atto
class File {
    susp read(max_bytes: int): Bytes;
    susp write(bytes: Bytes): int;
    susp seek(offset: int): int;
    susp flush(): void;
    susp close(): void;
}
```

Passing the same File instance directly:

```atto
import * as fs from "std.fs";

pub susp fnc render(fs.File file): string {
    return await fs.read_text(file);
}

pub susp fnc main(): int {
    val options = fs.OpenOptions {
        read: true, write: true, create: true, truncate: true
    };
    val file = await fs.open("data/info.txt", options);
    await fs.write_text(file, "Hello");
    await file.seek(0);
    val text = await render(file);   // no FileStream
    await file.seek(0);
    val bytes = await fs.read_file(file);
    await file.close();
    if text != "Hello" then return 1; fi
    return 42;
}
```

The Atto constructor/type notation is a proposed public API: **the typed
guest import, `File` lowering, `seek` lowering, and filesystem permission
ABI are not yet linked or compiler-tested**. This example is `NOT_EXECUTED`
as a guest, and never constitutes production runtime support.

## Host memory-VFS candidate

The current trusted-host JS adapter implements `open(token, path, options)`
which returns an opaque host File object. The adapter accepts that **same
object** as the second argument to `read_text`, `write_text`,
`read_file` and `write_file`. It also exposes `file.seek(offset)` to
position the handle's byte cursor; `file.close()` is always explicit.

For example, at the *trusted host adapter level*, not inside Atto:

```js
const actor = fs.open_actor(1, 1, {read:true,write:true});
const file = await fs.open(actor,"note",{read:true,write:true,create:true});
await fs.write_text(actor,file,"Hello");
await file.seek(0);
const content = await fs.read_text(actor,file);
await file.close();
```

Overload semantics:

- `read_text(File)` and `read_file(File)` read from **current cursor to
  EOF**. A second read at EOF is empty. `file.seek(0)` rewinds.
- `write_text(File,...)` and `write_file(File,...)` write at the
  current cursor (or EOF in append mode) and do **not** truncate at call
  time, unlike path-based `write_text(path,...)`.
- All File overloads preserve handle ownership and never close it.
  The host adapter authenticates the opaque identity and actor incarnation;
  impostors, wrong actor/tenant, closed handles and denied read/write modes
  are rejected. A quota failure does not mutate bytes in this memory-only
  implementation.
- This host File object remains **host-only** and must not be exposed as
  an untrusted guest handle: typed actor-bound guest handles and the
  compiler-generated File class are still missing.

**Verification scope:** 24 host-only JS test groups were exercised in an
in-process V8 harness with ASCII text and assertion shims in both JS and Wasm
candidate branches. This is not executed Node 22 GitHub Actions, and **no
compiled Atto guest test has passed**.
