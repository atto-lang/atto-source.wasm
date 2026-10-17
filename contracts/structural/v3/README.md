# Structural arrays, lists and maps — v3 target contract

Status: **target-only proposal, NOT compiled or guest parity**. This adds collection-shape rules to the v1 structural-record and v2 tuple inventories; it does **not** claim parser or compiler implementation. Identical `cases.json` bytes are required in all five `oreslang-source.*` backends.

## Distinct kinds and source forms

- `structural Array<T>`: borrowed readonly view of a dynamically sized homogeneous array, with index reads only. Unknown length is fine for indexed reads but **never** permits tuple packing or static spread.
- `structural FixedArray<T,N>`: homogeneous fixed array with **exact** compile-time extent `N` (0..64 for this first proof). A zero-width fixed array still retains `T`; empty shape never erases element identity. No tuple or dynamic-array conversion.
- `structural List<T>` and `structural FixedList<T,N>`: readonly sequential views, with distinct list vs array and fixed-list vs tuple identities. `FixedList<T,0>` also retains `T`; zero elements do not erase type/capability metadata. Mutable list operations are not visible on the view.
- `structural Map<K,V>`: readonly lookup/iteration view. Missing keys return `Option<V>`; structural width is **not** a claim that arbitrary keys are present. Keys must retain exact hash/equality identity; key covariance and unstable/unknown key types are rejected.

## Authority and element variance

A readonly structural collection view is a **scoped, non-escaping loan**. It may borrow a mutable source, but cannot add writes, be stored in a longer-lived reference, cross `await`/suspend, enter an actor mailbox or transport, or be mistaken for a deep-immutable owned collection. Owned Java `Map<K,V>` values are also intentionally fail-closed for channel, async-task, actor, and shared-memory transport until explicit move/serialization semantics are proven. Any such transfer needs its own explicit sendability, lifetime and ownership proof.

For an actual writable collection, both kind/extent and key/element/value types must be invariant. Readonly element/value covariance is permitted *only* with a closed, safe representation-preserving projection (e.g., an immutable string literal type to `string`, or separately proven readonly record-member projection). Numeric widening, unresolved generics/`Unknown`, functions, mutable borrows, nested mutable containers and unsafe object aliases must not become proof by calling a normal permissive assignability function. Map keys **always** remain invariant, even in readonly views; only trusted canonical primitive keys with stable hash/equality are eligible in the initial policy.

No implicit conversion between `Array`, `List`, `Map`, `FixedArray`, `FixedList`, tuple, record or host collection. Do not reinterpret fixed-width arrays as positional tuples. Structural view admission is checked at compile time; no runtime shape dispatch, same-arity overload based solely on collection shape, dynamic-length spread or hidden mutation authority.

## Conformance and release gate

- `cases.json` contains **38 decision cases**: 9 target accepts, 29 target rejects. They are *normative targets* and not a passing test suite.
- Java now also contains source-level typechecker plumbing for readonly structural collection parameters, distinct Array/List identities, fixed-kind/extent admission, Map<K,V> key/value checks, and non-escape/mutation rejection. This source implementation is **not certified** until the exact-head JUnit/guest workflow executes successfully. Array/List guest reads and Java Map construction, owned put, optional get, stable-key admission, and key/value entry iteration now have checked-in guest regression coverage; these changes are **not certified** until the exact-head workflow executes successfully. Cross-backend lowering remains incomplete. Other backends remain target-only/not implemented until genuine parser, ownership, emitter and runtime support lands.
- All five backends must validate the same case IDs, expectations, exact source blobs, version, proof bound and immutable inventory. A green inventory check must never be treated as native or guest parity.
- Positive backend evidence requires real typed AST parsing; checked readonly borrow and non-escape; actual array/list/map read and map lookup execution; repeated negative tests for mutating/escaping/unknown inputs; and per-backend exact-head compiler/guest artifacts. For WASM specifically, require wasm32 output **and** guest execution; host-only LLVM tests are insufficient.
