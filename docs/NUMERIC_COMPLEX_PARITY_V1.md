# Complex-number parity gate — draft v1

Status: **shared source-free finite-complex128 reference only, not executed Oreslang guest parity**.
This contract is an implementation target, not a declaration of runtime feature support.

## Existing branch provenance

- [Java math draft #120](https://github.com/ores-truffle-oreslang/oreslang-source.java/pull/120):
  `complex`, `Vector<complex>`, `Matrix<complex>`, literal/type-checker,
  `@` matrix multiplication, conjugation, immutable actor transport and
  electrical-engineering routines are staged; **not merged on Java main**.
- [Java numerical hardening #1033](https://github.com/ores-truffle-oreslang/oreslang-source.java/pull/1033):
  complex128 IEEE arithmetic, extreme exponent division/multiplication,
  mixed-domain coercion refusal, and source guest regressions are staged;
  exact-head GraalVM/Maven/AOT tests **not executed**.
- [Java issue #1042](https://github.com/ores-truffle-oreslang/oreslang-source.java/issues/1042)
  is still open for correctly rounded extreme-exponent complex division.
- [Java GPU math #153](https://github.com/ores-truffle-oreslang/oreslang-source.java/pull/153)
  was merged into its **GPU feature branch**, **not proof of Java mainline
  or hardware-executed GPU complex64/complex128 parity**.
- LLVM, .NET, Wasm and Forge: this shared oracle establishes no complex guest
  implementation or compiler support. Each backend must supply and run
  genuine source/guest tests, or explicitly reject unsupported forms.

## Reference corpus and limitations

`contracts/v1/numeric-complex/complex128-finite-reference-v1.json`
holds thirteen cases for add/subtract/multiply/divide/conjugate and one
complex row-major matrix multiplication. Operands are short decimal text
first parsed as **IEEE binary64**. The source-free Python oracle then
uses **exact rational arithmetic on those decoded binary64 values** and
independently rounds each finite result component once to binary64,
comparing hexadecimal bits. This avoids using a Python complex operation
as its own correctness oracle, and includes:

- Known [#1042](https://github.com/ores-truffle-oreslang/oreslang-source.java/issues/1042)
  exponent-separation repro, expected imaginary bits `02aa36a9fdaa506a`,
  **not zero** despite the tiny magnitude.
- A balanced finite division whose simple scaled-double result is one ULP
  wrong in each component, plus a subnormal-output division that requires
  exact final rounding rather than compensated scaling alone.
- Equal huge and tiny finite numerator/denominator pairs that should
  give `1+0i` without avoidable intermediate overflow or underflow.
- Minimum binary64 subnormal imaginary product (`0000000000000001`),
  ordinary sign/cross-term multiplication, and conjugation.
- Complex `1×2 @ 2×1` reference result `19+8i`, preserving row-major
  scalar complex products rather than component-wise multiplication.

The source-free oracle validates its own corpus but **does not run an Oreslang
parser, compiler, stdlib, matrix evaluator, or GPU kernel**. The manifest
explicitly records **all five backends as `unverified`** and rejects
attempts to promote that value based on self-reported or synthetic checks.

The finite contract is now paired with
`contracts/v1/numeric-complex/complex128-ieee-special-v1.json`, a
14-vector raw-bit special-value corpus. It pins signed-zero quadrants,
finite-overflow-to-infinity, subnormal ties-to-even, division by zero,
finite/infinite division, compiler-rt-style infinity recovery and
subnormal-divisor prescaling. Expected NaN components are classification
checks only; NaN payload bits are deliberately **not** standardized by
this arithmetic contract.

Both fixtures and their **18 total source-free test methods** (10 finite
plus 8 IEEE-special) are shared byte-for-byte across Java, LLVM, .NET,
Wasm and Forge. The restricted `numeric-complex-reference-v1.yml`
requires three complete no-skip rounds of both suites at the exact pull
request source HEAD, with a short-lived metadata-only artifact that
explicitly says native/guest parity is **false**.

## Acceptance gates for genuine cross-backend support

1. **Syntax/type:** parse and type-check `2i`, `1.0+2.0i`, complex
   locals/parameters/returns and `Matrix<complex>`. An `IMAG` token's
   numeric payload is a binary64 literal exactly like `FLOAT`: integer
   spelling does **not** turn `9007199254740993i` into an exact integer
   promotion, so it rounds to the nearest binary64 value just as Java
   `Double.parseDouble` does. Ordinary integer-value promotion to
   complex remains lossless-only. Decimal digit separators are accepted
   only between two digits for INT/FLOAT/IMAG. Reject lossy implicit exact
   Decimal or BigInt conversions. Do not assume the proposed `Complex<T>`
   generic is available from the lowercase `complex` type.
2. **Arithmetic:** execute all thirteen scalar vectors through the actual
   compiler/guest runtime, including wide-exponent divisions,
   subnormal imaginary components, signed cross terms and conjugation.
   For finite complex128 multiplication and division, the v1 target is the
   exact-rational result rounded once per component to IEEE binary64
   round-to-nearest, ties-to-even. Backends may optimize that result only
   with an equivalence proof or a guarded fallback. Do not silently convert
   complex128 to complex64.
3. **IEEE edge semantics:** arithmetic signed-zero, infinities, division
   by zero, subnormal divisor scaling, finite overflow and NaN-result
   classification are frozen by `complex128-ieee-special-v1.json`.
   Backends must match raw bits for every non-NaN component and return a
   NaN for every NaN-classified component. NaN payload preservation,
   `eq`/unordered comparisons and any optional total ordering remain
   separate contracts and must not be inferred from this arithmetic gate.
4. **Matrices and actor safety:** execute matrix `@`, shape mismatch,
   transpose versus Hermitian, singular/rank-deficient solves, row-major
   real/imag storage, immutable transfers and ownership/quota isolation.
   Actor DATA/CONTROL serialization must specify and test the complex
   wire encoding; host-only `OresComplex` does not imply a valid wire type.
5. **Devices/precision:** test GPU-native complex64/complex128 with
   per-operation rounding, resource lifetimes, no implicit CPU fallback,
   and native-vs-portable differential results. Exact
   `Complex<Decimal>`/`Complex<BigFloat>` needs separate limb/precision
   budget and conversion contracts; no silent binary64 fallback.
6. **Provenance:** run compiler-generated guest tests on authorized
   exact-head source in each backend, preserve full test names,
   toolchain, runner/job identity, JUnit/TAP, actual binaries/wire
   artifacts, and independently checked hashes. Keep unsupported
   domains labeled explicitly, and keep all integration PRs draft
   until source-owner/security gates and real execution evidence pass.

## Independent hosted control (not a compiler run)

A separately authored, source-free oracle actually executed in
[ClipTown run #39041344243](https://github.com/cliptown/cliptown-e2e/actions/runs/39041344243):
**10/10 test methods passed**, including exact rational numerical
vectors and fail-closed negative mutations. Its uploaded
[artifact #12103977875](https://github.com/cliptown/cliptown-e2e/actions/runs/39041344243/artifacts/12103977875)
is only metadata/runner evidence. No private Oreslang Git tree was
mirrored to this carrier. The source organization previously produced
jobs with no allocated runner, so actual source CI remains unverified.

## Java scalar integration progress (2026-10-17)

The **current Java actor/serde/arena draft** [#1124](https://github.com/ores-truffle-oreslang/oreslang-source.java/pull/1124)
now forward-ports only the reviewed `Complex` evaluator record from Java
precision branch [#1033](https://github.com/ores-truffle-oreslang/oreslang-source.java/pull/1033)
onto the current integration source—not the stale matrix/EE #120 tree.
It now routes scalar arithmetic through a dedicated
`dev.oreslang.runtime.Complex128Math` kernel. Finite multiplication and
division decode each binary64 input into an exact signed dyadic
significand/power-of-two pair, perform the exact products/sums or rational
quotient with bounded `BigInteger` work, and round each output component
once using IEEE binary64 round-to-nearest, ties-to-even. There is no fixed
decimal `MathContext` and no unproven compensated result in the finite v1
path. Stacked Java hardening [#1140](https://github.com/ores-truffle-oreslang/oreslang-source.java/pull/1140)
adds compiler-rt-style exceptional multiplication/division recovery,
finite-divisor prescaling, and signed-zero preservation for the exact
division path; those semantics are now reflected in the shared IEEE-special
corpus. The evaluator orders guest numeric equality before object identity
(`NaN != NaN` even for the same complex instance), preserves signed-zero
formatting, and rejects implicit BigInt/Decimal narrowing into binary64
complex. Integral value promotion into `complex`/`complex128` is
lossless-only (absolute value at most 2^53); the same rule is enforced at
arithmetic, typed binding/parameter, and declared-return coercion boundaries.
Java now rejects
`complex64` at type resolution rather than silently backing a binary32
spelling with the binary64 `Complex128Math` runtime. Decimal/complex
mixing is also rejected statically and the type lattice preserves their
join as a precise union rather than permissive `Unknown`.

The new **`src/test/java/dev/oreslang/NumericComplexIntegrationTest.java`**
contains nine focused **real guest-language GraalVM JUnit tests**:
basic complex addition/subtraction/cross-term multiplication, scaled
large/small division, [#1042](https://github.com/ores-truffle-oreslang/oreslang-source.java/issues/1042)
representable tiny imaginary result, minimum subnormal multiplication,
a once-rounded cross-term multiplication regression, complex NaN
self-equality, large/small purely imaginary division, a balanced one-ULP
division regression and exact subnormal-result rounding.
Java's existing Maven `verify` CI selects its normal JUnit test suite.
These tests are **committed, NOT passed** on an allocated source runner.

This is **not** all of #120: guest Vector/Matrix/EE, stable
`Complex<T>` generic typing, complex serialization, AOT/native and
GPU execution still require integration and test. Direct raw-bit JUnit
regressions now pin five independently generated multiplication cases that
the former rounded-product/rounded-sum path missed, plus #1042, balanced
division and subnormal-output division. A separate local differential audit
compared 20,000 random finite multiplications and 20,000 random finite
divisions against independently generated exact-rational results with no
nonzero-component bit mismatches; this is useful engineering evidence but
is **not** authorized exact-head source CI. The arithmetic IEEE-special contract is now explicit, but exact-head Java
Maven/GraalVM/Native Image execution remains blocked by runner admission.
Keep [division issue #1042](https://github.com/ores-truffle-oreslang/oreslang-source.java/issues/1042)
open until exact-head GraalVM+LLVM execution and independent review pass.
All five backend execution-status fields remain `unverified`; a committed
implementation or source-free oracle is not a compiled parity claim.

## LLVM typed scalar integration progress (2026-10-17)

A focused branch stacked on LLVM integration PR
[#504](https://github.com/ores-truffle-oreslang/oreslang-source.llvm/pull/504)
introduces the first real native complex128 value category without weakening
the existing checked-i64 ownership boundary. This first slice is deliberately
narrow: zero-argument, return-only `complex` functions may contain binary64
real/imaginary literals, exact-range integer promotion, unary negation,
addition and subtraction. LLVM lowers them by value as `{ double, double }`.
Complex parameters, locals, calls, multiplication/division, Wasm and Cortex-M
remain fail-closed until their ABI/ownership/exact-rounding paths are added.
Conjugation is admitted only for an intrinsically complex receiver, matching
Java member semantics rather than contextual-promoting a real-only receiver.

The branch also registers a positive object-verification test and a native C
ABI harness that now covers nine compiler-generated complex functions and
eighteen raw binary64 components at both `-O0` and `-O2`, including
binary64 imaginary rounding, overflow, extreme underflow, signed underflow and
minimum-subnormal literals. The target-ABI workflow also registers the full
complex CTest subset on both x86-64 and ARM64 Clang runners. These tests are
**committed but not source-CI certified**: the source organization still terminates jobs before runner step
execution. Source-free Clang/GCC scanner checks and a synthetic LLVM aggregate
ABI link passed independently, but they do not replace exact-head compiler
execution.

## Frozen finite-reference input and issue identity admission

The finite-complex128 oracle now pins all **13** scalar vector identities
to their exact operation and binary64 input decimal strings, and pins
the `1×2 @ 2×1` complex matrix input planes. It also checks exact
source-issue anchors for Java #120, #1033, and division issue #1042.
A regenerated oracle result does **not** authorize replacing a
source input while leaving its old case ID in place. Changing the
canonical finite vectors requires reviewed contract changes and updated
test-side input commitments, not a silent self-consistent rewrite.
This guard is a code-review/data-integrity constraint, not a
cryptographic or runtime attestation.

Three new negative test methods exercise scalar input substitution with
matching recomputed expected bits, complex matrix input substitution
with recomputed output, and source issue-anchor forgery. The full
finite suite contains **13 declared unittest methods**; the source
workflow now requires all 13 in each of its three rounds. .NET, Wasm,
and Forge retain their extra eight-method IEEE-special reference
suite and their separate NaN/signed-zero contract. All backend
guest execution statuses still read `unverified`.

The private [ClipTown source-free control #39060089454](https://github.com/cliptown/cliptown-e2e/actions/runs/39060089454)
passed **7/7 independently written fixture-tampering tests** and
uploaded short-lived [artifact #12110614229](https://github.com/cliptown/cliptown-e2e/actions/runs/39060089454/artifacts/12110614229).
Its checks were not copied from the private Oreslang source tree;
**the actual source finite/IEEE oracle files and Oreslang native guest
compilers have not been tested successfully by that host**.
