# Wasm pooled-source actor: real compiler-managed guest scalar frame gate M1

**Status:** authored integration acceptance, stacked on Wasm #417. NOT_EXECUTED until an independently authenticated source compiler is available and actual Node/Clang guest tests execute on the exact PR head. No Java/LLVM/Wasm three-backend parity certification is implied.

## Dependency and scope

LLVM source [#1546](https://github.com/ores-truffle-oreslang/oreslang-source.llvm/pull/1546) adds private [64 x i64] guest frame storage to the restricted wasm32 scalar `on_message` codegen. The guest frame is in each compiled actor's **own WebAssembly.Instance linear memory**, distinct from the existing Worker-side managed `ActorArena`. The LLVM codegen still maintains a transient value cache on the Wasm engine's own function activation.

The Wasm test `tests/compiled-actor-guest-frame-m1.test.mjs` pins canonical `.atto` actor source bytes to existing legacy `.ores` fixture Git blob `adfc0b43463d7ce92d32a4b1b63602f91e527329` and explicitly requires:

1. A real absolute-path `oreslang-llvmc`, exact executable SHA-256, independently verified LLVM source HEAD **and tree SHA**. An asserted source SHA alone is not provenance: source/binary relationship requires a separately authenticated trusted build.
2. Actual frontend compilation of unchanged `.atto` actor with `--target=wasm32`. Generated LLVM IR must contain private [64 x i64] frame slots, checked depth, a volatile scalar frame write/read, cleanup and no legacy `message.slot` native alloca.
3. The existing source actor bridge must snapshot verified compiler/source bytes, link a bounded fixed two-page no-import wasm32 actor, and expose exact source/compiler/IR/Wasm SHA-256 receipts.
4. Real `PooledWasmActors` execution on **one** trusted Worker with two independent compiled actor instances: 65 sequential messages to actor A (one frame per *message*, NOT 65 nested calls), actor B independent state, STOP A while B continues, fresh actor C and complete cleanup. Worker ACK frame-quiescence checks from #415/#417 remain intact.
5. Rejection of the changed recursive actor source by the actual native frontend (no stdout IR), and no publication of Wasm by the real compilation bridge. Unsupported source recursion must remain fail-closed until nested actor frame lowering is implemented.

## Execution

Default `npm test` runs the two source/provenance tests, while the native guest case is skippable in an environment without an approved LLVM compiler. A skipped guest test is not backend parity.

To **require** the real compiler and prohibit silent skipping, on an independently reviewed trusted source-runner:

```bash
ATTO_REQUIRE_WASM_GUEST_FRAME=1 \
ORESLANG_LLVM_COMPILER=/approved/absolute/path/to/oreslang-llvmc \
ORESLANG_LLVM_COMPILER_SHA256=<verified-64-lowercase-hex> \
ORESLANG_LLVM_SOURCE_SHA=<independently-verified-40-hex-source-head> \
ORESLANG_LLVM_SOURCE_TREE_SHA=<independently-verified-40-hex-tree> \
node --test tests/compiled-actor-guest-frame-m1.test.mjs
```

Equivalently `npm run test:real-actor-guest-frames` with the four `ORESLANG_LLVM_*` variables.

The test issues a single evidence diagnostic containing the source SHA, compiler/source/tree/Wasm/IR identity, worker count, guest-message count and **`actorRecursiveOverflowIsolation: "UNPROVEN"`**. Never treat the 65 **sequential** messages as a recursion or stack-overflow test.

## Security and follow-up gates

- The binary pin alone cannot independently prove that LLVM #1546 code produced it. Before certification, a trusted reviewer must verify the LLVM compiler source SHA/tree and the exact build product; no private LLVM source may be cloned or mirrored to another organization merely to recover CI minutes.
- GitHub Actions source-org jobs currently fail at runner admission, with provider evidence identifying payment/spend-limit refusal. An authorized billing owner must fix the specifically confirmed condition, run a source-free same-org canary with executed steps, then run both LLVM #1546 and Wasm exact-head positive/negative gates.
- PR remains draft until independent ORESoftware review and actual nonzero-step Node/Clang/compiler evidence. Node Worker is not an OS sandbox or native AOT proof.
- The next milestone is truly compiler-managed **nested** function calls, return PC/operand frames and bounded trampoline, producing a typed actor-scoped STACK_BUDGET_EXHAUSTED result before OS/Wasm engine call-stack exhaustion. Actor A should reach quota 65, B continue on the **same carrier**, and supervisor restart A with generation-fenced old tickets rejected. Execute that new canonical source fixture across Java, LLVM and Wasm. This M1 PR does **not** claim to achieve it.
