# std.actor — ActorFuture adapters (candidate)

This backend owns `stdlib/actor/future.atto` and declares
`use namespace std.actor;` (not `define module`).

`await_reply<T>(take! ActorFuture<T>) -> T` and
`await_reply_result<T,E>(take! ActorFuture<Result<T,E>>)`
delegate directly to the compiler's intrinsic `await`. They **do not**
construct, emulate, store or counterfeit sealed actor-future capabilities.
An actor request provider must issue the one-use typed result receipt only
after authenticating actor incarnation, tenant, request and control rights.

These routines need compiler support for generic `take!` formals and
affine suspension. The caller must also spell `take! reply` when invoking
them; awaiting a borrowed or already consumed receipt MUST fail before
code generation. Cancel/stop and physical quiescence are runtime-side
operations, never implied by successful `await`.

`future-owned.accept.atto` is a positive typecheck target;
`future-borrowed.reject.atto` and `future-double-await.reject.atto`
are negative compiler targets. `tests/actor-future-source.test.mjs` is
**only a structural test**, not guest execution. All Future fixtures
currently have **NOT_EXECUTED** status.
