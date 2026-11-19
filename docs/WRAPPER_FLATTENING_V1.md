# Recursive Future adoption and explicit Option flattening — v1

Status: proposal and partial implementation, 2026-10-16. This document is
the identical cross-backend contract for Java/GraalVM, LLVM, .NET, WASM and
Forge. Presence of this file does **not** imply backend implementation or CI.

## Rules

1. `async fnc f(): T` has eventual result `T`; invocation produces
   `Future<T>`. Do not force callers to declare `Future<T>` in signatures.
   The runtime-owned actor `async receive(Mail): void` invocation therefore
   completes through an internal `Future<void>`, with private runtime-only
   invocation authority.
2. Nested Oreslang Future results are recursively **adopted**:
   `Future<Future<Future<T>>>` is represented to Oreslang consumers as
   `Future<T>`. The outer result is not successful until the innermost
   operation settles. Each `await` returns `T`, without nested awaits.
3. The compiler must canonicalize Future's payload at type construction,
   inference, function return typing and generic substitution. Do not
   normalize across other constructors: `Future<Option<T>>` remains
   `Future<Option<T>>`. A Future-containing field or collection is not
   recursively traversed.
4. Only Oreslang-owned Futures may be adopted implicitly. Convert foreign
   host `CompletionStage` / Task / Promise through the backend's
   explicit interop adapter first. No guest callback may run on a producer,
   NIO reactor, completion or timer thread.
5. Inner rejection and cancellation preserve their terminal categories.
   Late completions cannot revive a cancelled outer observer. Cancellation
   of an observing flattened Future must detach its waiters; it does not
   implicitly cancel shared source or inner Futures. Ownership of a child
   task may authorize stronger cancellation separately.
6. Detect cyclic future dependencies deterministically. Await and
   actor message-lifetime accounting must finish only at terminal
   settlement; no blocking I/O or carrier-thread waiting.
7. Option nesting **is meaningful** and retained by default:
   `None`, `Some(None)` and `Some(Some(x))` are distinct values.
   `Option<Option<T>>` is not equal to `Option<T>`.
8. `Option.flatten()` is an explicit recursive operation. For zero or
   more nested Option constructors, flatten to one `Option<T>`:
   `Some(Some(x)) -> Some(x)`, `Some(None) -> None`,
   `None -> None`, `Some(Some(None)) -> None`.
   It must not invoke guest callbacks or silently copy/move affine payloads.
   For owned non-Copy payloads, the operation consumes/loans correctly
   under the borrow checker (fail closed until proven).
9. Do not implicitly flatten `Result`, `Stream`, `Channel`,
   `Observable`, `List`, or mixed carriers.

## Examples

```oreslang
async fnc answer(): int { return 42; }

// Runtime actor hook: framework dispatch only.
define actor Connection as
    async receive(Mail mail): void {
        const data = await socket.read();
        process(data);
    }
end

val Option<Option<Option<int>>> nested = Some(Some(Some(42)));
val Option<int> flat = nested.flatten();
val Option<Option<int>> preserved = Some(None); // still Some
```

## Required executable acceptance evidence (per backend)

- Parse/type `async fnc(): void` as effective `Future<void>`;
  normalize Future nesting for declarations, calls, generic substitutions,
  returns, and `await`, without normalizing `Option`.
- Pending outer -> pending inner -> success: one terminal payload,
  no premature actor mailbox/message-credit release.
- Already-settled chains (depth >= 2048) do not overflow call stack.
- Inner failure, inner cancellation, outer cancellation race,
  late producer completion, waiter detachment, and cyclic self-adoption.
- NIO reactor / foreign host callbacks never execute Oreslang source code;
  no native-thread blocking in actor execution lanes.
- Option nesting preserved until explicit `flatten()`. Validate
  None / Some(None) / Some(Some(value)) and generic typing.
- Verify affine payload ownership and no duplicate drop/copy; use
  deterministic teardown for LLVM hard-real-time/zero-GC targets.
- Include negative tests for Future/Option implicit cross-flattening.

## Current implementation boundary

Java branch `feat/recursive-wrapper-flattening-20261016` introduces
`Option.flatten()` in the evaluator and type checker, and
`OresFutures.flatten` as a runtime iterative adoption primitive.
It does not yet connect canonical Future types and asynchronous return
lowering to that primitive. Tests are committed but not claimed passing.
Other backends retain fail-closed admission until native runtime,
type checker, parser and test integration are proven.
