import {parentPort} from 'node:worker_threads';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';
import {assertScalarActorAbi} from '../scripts/actor-scalar-abi.mjs';
import {ActorArena} from './actor-arena.mjs';
import {withManagedActorTurn} from './pooled-actor-frame-turn.mjs';

// Experimental trusted scalar actor carrier. One OS Worker owns MANY distinct
// Wasm instances. Never accept raw host imports or cross-instance pointers.
const actors = new Map();
const ABI = ['oreslang_wasm_actor_init', 'oreslang_wasm_actor_on_message',
  'oreslang_wasm_actor_teardown', 'memory'];
const CHECKED_STATUS_NAME = 'oreslang_wasm_actor_frame_status';
const I64_MIN = -(1n << 63n), I64_MAX = (1n << 63n) - 1n;

parentPort.on('message', request => {
  const {kind, id, incarnation, ticket} = request;
  try {
    if (!Number.isSafeInteger(id) || id <= 0 ||
        typeof incarnation !== 'string' || !/^[a-f0-9]{32}$/.test(incarnation) ||
        !Number.isSafeInteger(ticket) || ticket <= 0) throw Error('invalid carrier authority');
    if (kind === 'init') {
      if (actors.has(id)) throw Error('duplicate actor identity');
      const admitted = inspectWasmBytes(request.bytes, {
        maxModuleBytes: 1048576, maxMemoryPages: 2
      });
      if (admitted.memoryCount !== 1 || !admitted.hasMemoryMaximum ||
          admitted.memoryInitial !== 2 || admitted.memoryMaximum !== 2)
        throw Error('actor requires private fixed two-page memory');
      const module = new WebAssembly.Module(admitted.bytes);
      const exported = WebAssembly.Module.exports(module);
      const checkedRecursionV1 = exported.some(e =>
        e.name === CHECKED_STATUS_NAME && e.kind === 'function');
      // The strict binary ABI verifier checks full function signatures.
      // Four exports = legacy actor. Five = trusted, opted-in typed status.
      // An extra status-like export of wrong kind can never pass.
      assertScalarActorAbi(admitted.bytes, {checkedRecursionV1});
      if (exported.length !== ABI.length + (checkedRecursionV1 ? 1 : 0) ||
          !ABI.every(name => exported.some(e => e.name === name &&
            e.kind === (name === 'memory' ? 'memory' : 'function'))) ||
          (checkedRecursionV1 && !exported.some(e =>
            e.name === CHECKED_STATUS_NAME && e.kind === 'function')))
        throw Error('invalid scalar actor export ABI');
      if (WebAssembly.Module.imports(module).length) throw Error('guest imports denied');
      const instance = new WebAssembly.Instance(module, {});
      const e = instance.exports;
      if (e.oreslang_wasm_actor_init.length !== 0 ||
          e.oreslang_wasm_actor_on_message.length !== 1 ||
          e.oreslang_wasm_actor_teardown.length !== 0 ||
          (checkedRecursionV1 &&
            (typeof e[CHECKED_STATUS_NAME] !== 'function' ||
             e[CHECKED_STATUS_NAME].length !== 0)) ||
          !(e.memory instanceof WebAssembly.Memory))
        throw Error('invalid actor function arity or memory');
      // The host mints monotone actor IDs and independent random incarnation
      // tokens. Numeric arena incarnation=1 is safe only because this Worker
      // never reuses actor IDs; the transport checks the exact random token.
      const actor = {incarnation, exports: e, checkedRecursionV1,
        frames: new ActorArena({actorId: id, incarnation: 1})};
      actors.set(id, actor);
      const opened = withManagedActorTurn(actor.frames,
        () => e.oreslang_wasm_actor_init());
      if (checkedRecursionV1 && e[CHECKED_STATUS_NAME]() !== 0)
        throw Error('checked actor published terminal frame status during INIT');
      parentPort.postMessage({kind: 'ack', id, incarnation, ticket,
        result: null, frame: {...opened.frame, retired: false}});
      return;
    }
    const actor = actors.get(id);
    if (!actor || actor.incarnation !== incarnation) throw Error('stale actor incarnation');
    if (kind === 'send') {
      if (typeof request.value !== 'bigint' || request.value < I64_MIN || request.value > I64_MAX)
        throw Error('invalid signed-i64 actor message');
      const handled = withManagedActorTurn(actor.frames,
        () => actor.exports.oreslang_wasm_actor_on_message(request.value),
        {input: request.value, resultType: 'i64'});
      const result = handled.value;
      if (actor.checkedRecursionV1 &&
          actor.exports[CHECKED_STATUS_NAME]() !== 0)
        throw Error('checked actor returned ordinary i64 despite terminal frame status');
      if (typeof result !== 'bigint' || result < I64_MIN || result > I64_MAX)
        throw Error('actor result must be i64');
      parentPort.postMessage({kind: 'ack', id, incarnation, ticket,
        result, frame: {...handled.frame, retired: false}});
      return;
    }
    if (kind === 'stop') {
      // Revoke the binding before guest teardown; failure is terminal for
      // this entire carrier, never a retry on partly retired state.
      actors.delete(id);
      const stopped = withManagedActorTurn(actor.frames,
        () => actor.exports.oreslang_wasm_actor_teardown());
      if (actor.checkedRecursionV1 &&
          actor.exports[CHECKED_STATUS_NAME]() !== 0)
        throw Error('checked actor published terminal status during clean STOP');
      new Uint8Array(actor.exports.memory.buffer).fill(0);
      actor.frames.retire(); // No outstanding async, FFI or IO lifetime pins.
      parentPort.postMessage({kind: 'ack', id, incarnation, ticket,
        result: null, frame: {...stopped.frame, retired: actor.frames.retired}});
      return;
    }
    throw Error('unsupported actor operation');
  } catch (error) {
    // Only a synchronous, module-raised Wasm `unreachable` trap can be
    // isolated at actor scope with the current fixed/zero-import ABI.
    // Engine stack exhaustion, memory OOB, uncertain host failures, and
    // asynchronous/foreign exceptions remain whole-carrier fatal.
    // A guest cannot manufacture JS RuntimeError in this zero-import profile.
    const recoverable = kind === 'send' &&
      error instanceof WebAssembly.RuntimeError &&
      error.message === 'unreachable';
    const actor = recoverable ? actors.get(id) : null;
    let typedFrameFailure = false;
    if (actor?.checkedRecursionV1 && actor.incarnation === incarnation) {
      try {
        const terminalCode = actor.exports[CHECKED_STATUS_NAME]();
        if (terminalCode !== 0 && terminalCode !== 1)
          throw Error('invalid checked actor terminal status');
        typedFrameFailure = terminalCode === 1;
      } catch (statusError) {
        // A broken status read is a whole-carrier failure, not an
        // actor-local typed outcome: never forge a terminal receipt.
        parentPort.postMessage({kind: 'fatal', id, incarnation, ticket,
          reason: 'checked actor terminal status could not be verified'});
        return;
      }
    }
    if (actor && actor.incarnation === incarnation) {
      try {
        // Revoke actor identity BEFORE scrubbing. Its logical host frame
        // already unwound in withManagedActorTurn's finally path.
        actors.delete(id);
        if (actor.frames.stackExecutionCount !== 0 ||
            actor.frames.stackBytesInUse !== 0 ||
            actor.frames.pendingLifetimePins !== 0)
          throw Error('trapped actor retains frame or lifetime leases');
        // Private fixed-size guest instance memory cannot alias another
        // actor's Wasm linear-memory object on this strict ABI.
        new Uint8Array(actor.exports.memory.buffer).fill(0);
        actor.frames.retire();
        if (!actor.frames.retired) throw Error('actor fault retirement failed');
        parentPort.postMessage({kind: 'actor_fault', id, incarnation, ticket,
          code: typedFrameFailure ? 'STACK_BUDGET_EXHAUSTED_V1' :
            'WASM_UNREACHABLE_V1', result: null,
          frame: {schemaVersion: 1, frameBytes: 16,
            activeExecutions: 0, frameBytesInUse: 0, retired: true}});
        return;
      } catch (cleanupError) {
        // Any uncertain physical cleanup must quarantine the entire carrier.
        error = Error('actor fault isolation cleanup failed: ' +
          String(cleanupError?.message || cleanupError).slice(0, 120));
      }
    }
    parentPort.postMessage({kind: 'fatal', id, incarnation, ticket,
      reason: String(error?.message || error).slice(0, 200)});
  }
});
