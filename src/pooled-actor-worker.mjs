import {parentPort} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';
import {assertScalarActorAbi} from '../scripts/actor-scalar-abi.mjs';
import {ActorArena} from './actor-arena.mjs';
import {withManagedActorTurn} from './pooled-actor-frame-turn.mjs';
import {ActorTaskLedger} from './actor-task-lifecycle.mjs';
import {makeActorTaskReceipt} from './actor-task-quiescence.mjs';
import {scrubFixedGuestMemory} from './pooled-actor-guest-scrub.mjs';
import {ACTOR_FRAME_PROFILES} from '../scripts/actor-frame-profile.mjs';

// Experimental trusted scalar actor carrier. One OS Worker owns MANY distinct
// Wasm instances. Never accept raw host imports or cross-instance pointers.
const actors = new Map();
const ABI = ['oreslang_wasm_actor_init', 'oreslang_wasm_actor_on_message',
  'oreslang_wasm_actor_teardown', 'memory'];
const I64_MIN = -(1n << 63n), I64_MAX = (1n << 63n) - 1n;

parentPort.on('message', request => {
  const {kind, id, incarnation, ticket} = request;
  try {
    if (!Number.isSafeInteger(id) || id <= 0 ||
        typeof incarnation !== 'string' || !/^[a-f0-9]{32}$/.test(incarnation) ||
        !Number.isSafeInteger(ticket) || ticket <= 0) throw Error('invalid carrier authority');
    if (kind === 'init') {
      if (actors.has(id)) throw Error('duplicate actor identity');
      if (typeof request.expectedSha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(request.expectedSha256) ||
          ![null, ...Object.values(ACTOR_FRAME_PROFILES)]
            .includes(request.actorFrameProfile))
        throw Error('invalid host-approved actor profile binding');
      const admitted = inspectWasmBytes(request.bytes, {
        maxModuleBytes: 1048576, maxMemoryPages: 2
      });
      if (admitted.memoryCount !== 1 || !admitted.hasMemoryMaximum ||
          admitted.memoryInitial !== 2 || admitted.memoryMaximum !== 2)
        throw Error('actor requires private fixed two-page memory');
      assertScalarActorAbi(admitted.bytes);
      // Independently bind Worker-instantiated immutable bytes to the digest
      // approved by the host. Signature verification is host-only: the Worker
      // must not accept a guest-provided trust root or profile override.
      if (createHash('sha256').update(admitted.bytes).digest('hex') !==
          request.expectedSha256)
        throw Error('actor Worker artifact digest mismatch');
      const module = new WebAssembly.Module(admitted.bytes);
      const exported = WebAssembly.Module.exports(module);
      if (exported.length !== ABI.length ||
          !ABI.every(name => exported.some(e => e.name === name &&
            e.kind === (name === 'memory' ? 'memory' : 'function'))))
        throw Error('invalid scalar actor export ABI');
      if (WebAssembly.Module.imports(module).length) throw Error('guest imports denied');
      const instance = new WebAssembly.Instance(module, {});
      const e = instance.exports;
      if (e.oreslang_wasm_actor_init.length !== 0 ||
          e.oreslang_wasm_actor_on_message.length !== 1 ||
          e.oreslang_wasm_actor_teardown.length !== 0 ||
          !(e.memory instanceof WebAssembly.Memory))
        throw Error('invalid actor function arity or memory');
      // Transport checks the random incarnation; worker-local IDs are never reused.
      // ActorArena is the single canonical turn/frame authority (#415).
      const actor = {incarnation, exports: e,
        approvedFrameProfile: request.actorFrameProfile,
        frames: new ActorArena({actorId: id, incarnation: 1}),
        tasks: new ActorTaskLedger()};
      actors.set(id, actor);
      const opened = withManagedActorTurn(actor.frames,
        () => e.oreslang_wasm_actor_init());
      parentPort.postMessage({kind: 'ack', id, incarnation, ticket,
        result: null, frame: opened.frame,
        task: makeActorTaskReceipt(actor.tasks, 'init'),
        actorFrameProfile: actor.approvedFrameProfile});
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
      parentPort.postMessage({kind: 'ack', id, incarnation, ticket,
        result: handled.value, frame: handled.frame,
        task: makeActorTaskReceipt(actor.tasks, 'send'),
        actorFrameProfile: actor.approvedFrameProfile});
      return;
    }
    if (kind === 'stop') {
      // Revoke the binding before guest teardown; failure is terminal for
      // this entire carrier, never a retry on partly retired state.
      // #49 task ledger STOP is authoritative: cancellation alone is NOT
      // physical quiescence. Any live/suspended task forbids teardown ACK.
      actor.tasks.stop();
      if (!actor.tasks.isQuiescent())
        throw Error('actor task physical quiescence not proven');
      const stopped = withManagedActorTurn(actor.frames,
        () => actor.exports.oreslang_wasm_actor_teardown());
      scrubFixedGuestMemory(actor.exports.memory);
      actor.frames.retire();
      if (!actor.frames.retired || actor.frames.pendingLifetimePins !== 0)
        throw Error('actor frame physical retirement not proven');
      const task = makeActorTaskReceipt(actor.tasks, 'stop');
      // Revoke actor registry only AFTER independent task/frame and scrub gates.
      actors.delete(id);
      parentPort.postMessage({kind: 'ack', id, incarnation, ticket,
        result: null, frame: {...stopped.frame, retired: true}, task,
        actorFrameProfile: actor.approvedFrameProfile});
      return;
    }
    throw Error('unsupported actor operation');
  } catch (error) {
    parentPort.postMessage({kind: 'fatal', id, incarnation, ticket,
      reason: String(error?.message || error).slice(0, 200)});
  }
});
