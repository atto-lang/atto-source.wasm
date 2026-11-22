# AttoLang alloc/box, alloc/vec, alloc/string (backend-local source candidate)

Backend: atto-source.wasm. Vec growth floor: 4 elements.\n\nThese .atto modules are implemented in this backend's own `stdlib/alloc/` tree.
They are NOT a claim that imports, generic method receivers, heap allocation
and deterministic cleanup all execute on the current compiler head.

## API and safety contracts

- `alloc_box.OwnedBox<T>`: single-slot unique heap object, `boxed`,
  `empty`, `replace`, `take_value`, `is_full`, `is_empty`.
  There is **no alias-copy constructor**. This deliberately does not declare
  compiler-reserved intrinsic `Box<T>`; mapping to `Box<T>` requires verified
  unique-ownership and drop lowering.
- `alloc_vec.Vec<T>`: `new_vec`, `push` (ownership transfer), `len`,
  `is_empty`, `get_copy` (only proven Copy payloads), `clear`,
  `into_array` and overflow-safe `next_capacity`. `next_capacity` is a
  planning function, **not** an allocation/reserve operation. No unsafe
  `pop`, mutable slice, raw pointer exposure or silent clone is defined.
- `alloc_string.Utf8String`: heap-backed byte vector, Unicode scalar encoder,
  strict UTF-8 validator, character count, character-boundary check and
  checked scalar append. `String` conversion requires a separate trusted
  strict codec. `append_scalar` is not transactional on allocator OOM.

Required backend proof: resolve `atto.alloc/*` imports, execute the positive
fixture with real guest code, reject the use-after-take negative fixture,
prove no copied mutable aliases and exact-once drop across replace, clear,
return, throw/raise/panic and cancellation, validate OOM behavior and
sanitizer-backed storage bounds. Preserve existing backend-specific
allocators and arenas; do not couple these sources to atto-common-source.

Until all gates execute against an exact compiler SHA, status is
`SOURCE_CANDIDATE / GUEST_NOT_VERIFIED`, not parity-passed.
