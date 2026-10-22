# Private abstract actor hooks — canonical v1 contract

Status: **normative target**, not a claim of implementation or passing compiler tests.

## Authority and dispatch

A `private abstract` instance method is a virtual method slot that a
non-abstract descendant **must implement**. Its invocation authority belongs
exclusively to code lexically declared in the **originating superclass**.
An overriding descendant may implement but may not invoke that slot, including
via `self`, `super`, aliases, reflective/dynamic calls, or method-value capture.
Intermediate abstract redeclarations cannot acquire invocation authority.
Conflicting independent origins must be rejected rather than guessed.

Override identity is (instance/static namespace, name, **value arity**).
Overriding does not broaden visibility. The inherited callable contract still
requires compatible parameter types, return types, mutability and effects;
name-and-arity selection alone is not type safety. Generic substitutions must
be checked through the entire inherited class chain or the compiler must
reject the unsupported case explicitly. Signature mismatches are never
implicitly accepted.

## Actor runtime ingress

The conceptual hidden actor base owns `private abstract receive(ActorMail<T>
mail): void;`. Concrete actor source can implement
`receive(self, ActorMail<T> mail): void` or
`receive(ActorMail<T> mail): void`; these are the **same slot**, and the
untyped leading `self` has implicit `Self` type without adding a value
argument. Defining both signatures is a duplicate, not an overload.

The user implementation must never call or capture `receive` or `on_start`.
Only the trusted actor runtime invokes mailbox delivery/startup after its
own admission, ownership and scheduling checks. No direct, inherited, indirect,
dynamic, method-value or reflection-based bypass may dispatch a message.
User actor communication happens through `ActorRef` messages.

Explicit receiver syntax must be reconciled with the general
`method(self, ...)` grammar, without separate actor-only parsing rules.
A lambda in an actor method must not implicitly capture the receiver.

## Backend boundary and truthfulness

The same fixture corpus applies to all five source repositories. A backend
must either execute the source correctly **or** reject unsupported source
before emitting or publishing any executable artifact. Merely parsing JSON,
inspecting documentation, synthesizing IR or passing a host reference-model
test is NOT implementation evidence.

- Java: candidate implementation is draft PR #1090; mainline and full
  JDK25/GraalVM/Native Image results are not certified by this contract.
- LLVM: draft PR #479 experiments with `on_message(self, ...)` and does not
  establish general private-abstract class method dispatch. The mapping from
  LLVM's `on_message` to canonical `receive` must be resolved explicitly.
- .NET: fail-closed bootstrapping remains valid pending real class dispatch.
- Wasm: compilation must use a pinned real Oreslang LLVM frontend; successful
  Wasm guest execution, not JavaScript checks, establishes execution parity.
- Forge: preserve fail-closed source admission until real native codegen exists.

The corpus in `private-abstract-actor-hook-v1.json` and the offline verifier
define **expected** outcomes. They are not passing compiler evidence.

## Evidence gate

An implementation/parity claim requires a source SHA and Git-tree SHA, the
backend's actual compiler commit/binary identity, emitted native/JVM/Wasm
guest artifacts where supported, exact positive/negative fixture identifiers,
and logs showing executed steps, exit codes and meaningful diagnostics.
A negative fixture must fail for the specified authority/typing reason, not
an unrelated syntax or missing compiler error. Multi-backend parity is not
achieved until each backend's unsupported surface is explicitly gated and
supported surfaces have real executable proof.

Cross-repository private source export is DENY by default. Do not mirror a
private Git tree to another organization unless the destination is already
approved under the source's protected-branch security policy, verified private,
and pinned by immutable repository ID. No unreviewed branch, CI input, or
runner-capacity probe grants that approval.

References: Java #1090, #1087, #1105; LLVM #477, #479;
cross-backend actor reference fixtures in oreslang-platform-conformance #52.
