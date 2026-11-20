// Host-only normalization for typed continuous pipe/rpipe graph descriptors.
// No ActorRef, mailbox, supervisor CONTROL capability, or guest execution
// is created here. A trusted compiler must supply independently verified
// endpoint roles and an authenticated TenantVM identity before admission.
import {ActorPipelinePolicy} from './actor-pipeline-policy.mjs';

const MAX_STAGES = 16;
const MAX_NAME_BYTES = 256;
const encoder = new TextEncoder();
// A plan is a compiler preflight result, never a guest ActorRef capability.
const ownedPlans = new WeakSet();

function ownValue(obj, key) {
  if (!obj || typeof obj !== 'object')
    throw new TypeError('pipe stage must be an own-data descriptor');
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  if (!desc || !Object.hasOwn(desc, 'value'))
    throw new TypeError('pipe stage requires own data field ' + key);
  return desc.value;
}

function checkedLabel(value, label) {
  if (typeof value !== 'string' || !value || value.length > MAX_NAME_BYTES ||
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/u.test(value))
    throw new TypeError('unsafe pipe ' + label);
  for (let i = 0; i < value.length; ++i) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (++i >= value.length || value.charCodeAt(i) < 0xdc00 ||
          value.charCodeAt(i) > 0xdfff)
        throw new TypeError('invalid Unicode in pipe ' + label);
    } else if (code >= 0xdc00 && code <= 0xdfff)
      throw new TypeError('invalid Unicode in pipe ' + label);
  }
  if (encoder.encode(value).length > MAX_NAME_BYTES)
    throw new RangeError('pipe ' + label + ' byte budget');
  return value;
}

// Normalize written pipe (A->B) or rpipe (B->A) stages into an immutable
// typed DATA-edge graph. These are stage DESCRIPTORS, not user objects or
// live guest references. This does not execute a pipeline or grant tenancy.
// The caller must validate the supplied tenant and ports against its
// capability registry; this model refuses all direct cross-tenant edges.
export function planDirectedPipe(stages, direction) {
  if (direction !== 'pipe' && direction !== 'rpipe')
    throw new TypeError('pipe direction must be pipe or rpipe');
  if (!Array.isArray(stages)) throw new TypeError('pipe stage list must be an array');
  const length = Object.getOwnPropertyDescriptor(stages, 'length')?.value;
  if (!Number.isSafeInteger(length) || length < 2 || length > MAX_STAGES)
    throw new RangeError('pipe graph stage budget');
  const written = [], ids = new Set();
  let tenant;
  for (let i = 0; i < length; ++i) {
    const value = ownValue(stages, String(i));
    const id = checkedLabel(ownValue(value, 'id'), 'id');
    const type = checkedLabel(ownValue(value, 'type'), 'type');
    const identity = checkedLabel(ownValue(value, 'tenant'), 'tenant');
    const role = ownValue(value, 'role');
    const inbound = ownValue(value, 'inbound');
    const outbound = ownValue(value, 'outbound');
    if (typeof inbound !== 'string' || typeof outbound !== 'string')
      throw new TypeError('pipe types must be strings');
    if (inbound) checkedLabel(inbound, 'inbound type');
    if (outbound) checkedLabel(outbound, 'outbound type');
    if (ids.has(id)) throw new TypeError('duplicate pipe stage id');
    ids.add(id);
    if (tenant !== undefined && identity !== tenant)
      throw new TypeError('cross-tenant pipe denied: use an explicit authorized bridge');
    tenant = identity;
    written.push(Object.freeze({id, type, role, inbound, outbound}));
  }
  // Preserve source-written construction order independently from DATA flow.
  const flowIndices = Object.freeze(Array.from({length}, (_, i) =>
    direction === 'pipe' ? i : length - 1 - i));
  const order = flowIndices.map(i => written[i]);
  const edges = [];
  for (let i = 0; i + 1 < order.length; ++i) {
    const source = order[i], target = order[i + 1];
    if (!source.outbound || source.outbound !== target.inbound)
      throw new TypeError('pipe DATA edge type or source role mismatch');
    edges.push(Object.freeze({source: source.id, target: target.id, payload: source.outbound}));
  }
  // Existing host topology policy checks port roles, cycles, graph quotas,
  // duplicate routes, immutable snapshots and correct typed DATA edges.
  const selector = new ActorPipelinePolicy(order, edges);
  const plan = Object.freeze({direction, tenant,
    writtenStages: Object.freeze(written), flowIndices,
    stages: Object.freeze(order), edges: Object.freeze(edges), selector});
  ownedPlans.add(plan);
  return plan;
}

// Compiler-only cross-expression unicast preflight. Runtime admission still
// needs authenticated generations, exclusive leases, atomic rollback and
// checked Result<PipeHandle, PipeSetupError>. This grants no transport rights.
export function checkUnicastDirectedPipes(plans) {
  if (!Array.isArray(plans)) throw new TypeError('E_PIPE_PLANS');
  const length = Object.getOwnPropertyDescriptor(plans, 'length')?.value;
  if (!Number.isSafeInteger(length) || length > 64)
    throw new RangeError('E_PIPE_PLAN_LIMIT');
  const pairs = new Set(), outputs = new Set(), inputs = new Set();
  for (let i = 0; i < length; i++) {
    const plan = ownValue(plans, String(i));
    if (!plan || typeof plan !== 'object' || !ownedPlans.has(plan))
      throw new TypeError('E_PIPE_PLAN_CAPABILITY');
    for (const edge of plan.edges) {
      const source = JSON.stringify([plan.tenant, edge.source]);
      const sink = JSON.stringify([plan.tenant, edge.target]);
      const pair = JSON.stringify([source, sink]);
      if (pairs.has(pair)) throw new TypeError('E_PIPE_DUPLICATE_EDGE');
      if (outputs.has(source)) throw new TypeError('E_PIPE_OUTPUT_OCCUPIED');
      // Fan-in also needs an explicit typed join/merge adapter.
      if (inputs.has(sink)) throw new TypeError('E_PIPE_INPUT_OCCUPIED');
      pairs.add(pair); outputs.add(source); inputs.add(sink);
    }
  }
  return true;
}
