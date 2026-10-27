import {parentPort} from 'node:worker_threads';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';
import {assertScalarActorAbi} from '../scripts/actor-scalar-abi.mjs';

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
      const admitted = inspectWasmBytes(request.bytes, {
        maxModuleBytes: 1048576, maxMemoryPages: 2
      });
      if (admitted.memoryCount !== 1 || !admitted.hasMemoryMaximum ||
          admitted.memoryInitial !== 2 || admitted.memoryMaximum !== 2)
        throw Error('actor requires private fixed two-page memory');
      assertScalarActorAbi(admitted.bytes);
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
      actors.set(id, {incarnation, exports: e});
      if (e.oreslang_wasm_actor_init() !== undefined) throw Error('init must be void');
      parentPort.postMessage({kind: 'ack', id, incarnation, ticket, result: null});
      return;
    }
    const actor = actors.get(id);
    if (!actor || actor.incarnation !== incarnation) throw Error('stale actor incarnation');
    if (kind === 'send') {
      if (typeof request.value !== 'bigint' || request.value < I64_MIN || request.value > I64_MAX)
        throw Error('invalid signed-i64 actor message');
      const result = actor.exports.oreslang_wasm_actor_on_message(request.value);
      if (typeof result !== 'bigint' || result < I64_MIN || result > I64_MAX)
        throw Error('actor result must be i64');
      parentPort.postMessage({kind: 'ack', id, incarnation, ticket, result});
      return;
    }
    if (kind === 'stop') {
      // Revoke the binding before guest teardown; failure is terminal for
      // this entire carrier, never a retry on partly retired state.
      actors.delete(id);
      if (actor.exports.oreslang_wasm_actor_teardown() !== undefined)
        throw Error('teardown must be void');
      new Uint8Array(actor.exports.memory.buffer).fill(0);
      parentPort.postMessage({kind: 'ack', id, incarnation, ticket, result: null});
      return;
    }
    throw Error('unsupported actor operation');
  } catch (error) {
    parentPort.postMessage({kind: 'fatal', id, incarnation, ticket,
      reason: String(error?.message || error).slice(0, 200)});
  }
});
