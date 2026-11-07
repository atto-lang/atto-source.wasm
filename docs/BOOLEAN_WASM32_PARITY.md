# Typed bool -> Wasm32 parity: source pins, executable guest gate, and evidence

The source-aligned LLVM boolean suite in `oreslang-source.llvm/tests/native_bool_types.py`
contains positive programs optionally compared against Java. In this Wasm candidate,
four positive and five negative fixtures use byte-identical source bodies.
Two additional branch programs expect 37 and 13, not the easy-to-fake constant 42.

## Source-only lane: NOT_EXECUTED

The 11 canonical `.atto` files under `tests/fixtures/boolean-v1/`
are bound to Git blob SHA-1 values in the test manifest.
`boolean-wasm32-source-pins.yml` checks these bytes on an exact PR checkout.
This proves **source integrity only**; one real-guest test is deliberately skipped.
The existing checkout-free `source-free-runner-canary.yml` now also triggers on
boolean parity PR changes, so its nonzero-step runner admission can be independently
checked before the source test lane. It requests no token permissions or checkout.
A zero-step GitHub Actions run proves nothing, even if a source-only check exists.

## Manual strict execution lane: EXECUTED only after a stepful passing run

The existing `.github/workflows/real-llvm.yml` is `workflow_dispatch` only,
credentialed and now restricted to `refs/heads/main`. It cannot be used to
execute arbitrary PR heads against the private LLVM compiler. After protected
integration and independent review, a maintainer can dispatch it on `main`.

This lane pins LLVM to
`b83f540269a256e549cc9160b6b43bf37d33fb0f` with tree
`26e85b258061b206e4a145825df6dfe11065a499`,
verifies the authenticated checkout and exact `tests/native_bool_types.py`
Git blob `80056fbf9d67e3fb37a052652398c2dc3796540b`,
compares each of the nine shared `.atto` source bodies to the reviewed LLVM
native test literals, builds `oreslang-llvmc`,
hash-pins the executable, executes the existing real-compiler bridge suite
and then `npm run test:bool-wasm32`.
It must execute **six** real isolated Wasm32 zero-import i64 guests and
receive **five** LLVM frontend semantic type errors (exit 1, empty IR,
no Wasm artifact publication). No fallback compiler or host simulation counts.

For a separately approved local compiler/run, all metadata is mandatory:

```sh
ORESLANG_BOOL_WASM_PARITY_REQUIRED=1 \
ORESLANG_BOOL_WASM_EXPECTED_HEAD=<exact-wasm-checkout-commit> \
ORESLANG_LLVM_COMPILER=/absolute/path/to/oreslang-llvmc \
ORESLANG_LLVM_COMPILER_SHA256=<64-hex-digest> \
ORESLANG_LLVM_SOURCE_SHA=<reviewed-llvm-commit> \
ORESLANG_LLVM_SOURCE_TREE=<reviewed-llvm-git-tree> \
ORESLANG_LLVM_REFERENCE_BOOL_PATH=/absolute/path/to/tests/native_bool_types.py \
node --test tests/boolean-source-parity-wasm32.test.mjs
```

After a complete passing strict run, the test may write a minimal JSON case receipt
to the absolute `ORESLANG_BOOL_WASM_RECEIPT_PATH` with exclusive creation.
The manual workflow uploads the receipt as a GitHub artifact. It includes
Wasm HEAD/tree, compiler SHA-256, reviewed LLVM test Git blob,
six observed i64 results and module hashes, five typed-rejection diagnostics,
and precise fixture Git blobs.
It **does not** contain private source bytes or license a copy to another org.

## Independent verifier responsibilities

The LLVM SHA/tree supplied to the Node test are **metadata**, not proof of
compiler provenance. An independent verifier must examine the workflow/run/job
identity, exact checked-out SHA and tree, successful nonzero test steps,
the authenticated LLVM checkout and compiler build step, and the unmodified
artifact. A receipt alone is not a self-authenticating certificate.
Java executed evidence is **NOT_EXECUTED** until its own exact-source fixture
run is recorded and compared. Five-backend parity remains **NOT_CERTIFIED**.
A Node Worker does not confer OS process isolation or strict native AOT.

**Do not** export the private LLVM or Wasm source into another organization
without the separate approved private-CI source-snapshot authorization.
