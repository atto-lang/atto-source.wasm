import {ActorArena} from "./actor-arena.mjs";

// Trusted Worker-only bridge from a synchronous, import-free Wasm actor call
// to the actor-owned managed logical-frame arena. Guest Wasm locals and the
// WebAssembly engine call stack remain separate (compiler lowering pending).
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const FRAME_BYTES = 16;
const boundedI64 = (value, field) => {
  if (typeof value !== "bigint" || value < I64_MIN || value > I64_MAX) {
    throw new TypeError(field + " must be signed i64");
  }
  return value;
};

export function withManagedActorTurn(arena, invoke, {input = 0n, resultType = "void"} = {}) {
  if (!(arena instanceof ActorArena)) throw new TypeError("trusted actor arena required");
  if (typeof invoke !== "function") throw new TypeError("synchronous Wasm invocation required");
  if (resultType !== "void" && resultType !== "i64")
    throw new TypeError("unsupported managed actor result ABI");
  boundedI64(input, "managed actor turn input");

  // No asynchronous carrier closure may extend an admitted turn; suspension
  // requires an explicit compiler/runtime continuation ABI (not yet lowered).
  const turn = arena.beginTurn();
  let execution = null;
  let finished = false;
  try {
    execution = arena.startStack(turn);
    const frame = arena.pushStackFrame(turn, execution, FRAME_BYTES);
    const record = new Uint8Array(FRAME_BYTES);
    const view = new DataView(record.buffer);
    view.setBigInt64(0, input, true);
    arena.writeStackFrame(turn, execution, frame, record);

    const value = invoke(); // real synchronous WebAssembly.Instance export
    if (resultType === "void") {
      if (value !== undefined) throw new TypeError("actor lifecycle entry must return void");
    } else {
      boundedI64(value, "managed actor result");
    }
    view.setBigInt64(8, resultType === "i64" ? value : 0n, true);
    arena.writeStackFrame(turn, execution, frame, record);
    const observed = arena.readStackFrame(turn, execution, frame);
    const checked = new DataView(observed.buffer, observed.byteOffset, observed.byteLength);
    if (checked.getBigInt64(0, true) !== input ||
        checked.getBigInt64(8, true) !== (resultType === "i64" ? value : 0n)) {
      throw new Error("managed actor frame byte integrity failure");
    }
    arena.popStackFrame(turn, execution, frame);
    arena.finishStack(turn, execution);
    finished = true;
    return {
      value,
      // This is trusted host bookkeeping evidence, NOT independent proof of
      // guest call-frame lowering, AOT, isolation or supervisor delivery.
      frame: Object.freeze({schemaVersion: 1, frameBytes: FRAME_BYTES,
        activeExecutions: arena.stackExecutionCount,
        frameBytesInUse: arena.stackBytesInUse})
    };
  } finally {
    // A guest trap, ABI violation, or other host failure may not leave
    // a resumable host stack behind after the physical call unwinds.
    if (!finished && execution !== null) arena.cancelStack(turn, execution);
    arena.endTurn(turn);
  }
}
