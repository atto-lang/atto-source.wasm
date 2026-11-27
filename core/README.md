# Atto core slice, iter, cmp (first source-owned increment)

These are implementation files, not declarations of a runtime-provided safe Slice<T> or Iterator<T> ABI.

* `slice.atto`: allocation-free bounds-safe logical windows and integer element operations on pre-existing `Array<int>`.
* `iter.atto`: allocation-free cursor arithmetic and callback-based fold/any/all/find/count on pre-existing arrays.
* `cmp.atto`: int/bool total ordering, min/max/clamp, lexicographic array ordering and sortedness checks.

All functions use signed `int` bounds; bounds are validated with subtraction after comparisons to avoid overflow. Invalid reads return `Option` rather than a sentinel, while invalid boolean predicates return false. Empty valid ranges are admitted and do not read elements. The `*_int` functions operate on copyable scalar elements only. Comparators produce -1/0/1 without subtraction overflow.

## Explicitly not yet implemented
A general `Slice<T>`/`SliceMut<T>` borrowed view and lifetime/generation enforcement, generic `Iterator<T>`/`IntoIterator<T>` and lazy adapters, zero-copy mutable chunk/split operations, an `Ordering` algebraic data type, and arbitrary `Ord` generic dispatch require type-checker/runtime support. A function accepting an `Array<int>` is not sufficient proof of memory safety or absence of underlying array allocation.

The proposed import fixture is in `tests/slice_iter_cmp_smoke.atto`. It must only be counted as passing after each compiler wires `atto.core` package resolution and executes the fixture at the exact PR head. Do not report source presence as executed conformance. Independent backend implementations are permitted; match public semantics and negative bounds behavior.
