// Compiler/host-only planning for proposed Actor.pipe(...) / Actor.connect(...).
// This NEVER spawns an actor, creates a mailbox, binds capabilities, or executes guest AttoLang.
// Only trusted compiler-generated metadata may reach this module; JS Proxy traps are not a sandbox.
import { ActorPipelineSelector } from "./actor-pipeline-selector.mjs";

const encoder = new TextEncoder();
const MAX_STAGE_COUNT = 1024;
const MAX_FIELD_BYTES = 256;

function ownData(value, field) {
  if (typeof value !== "object" || value === null)
    throw new TypeError("factory stage must be compiler-owned data");
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  if (!descriptor || !Object.hasOwn(descriptor, "value"))
    throw new TypeError("factory stage fields must be own data properties");
  return descriptor.value;
}

function checkedName(value, optional = false) {
  if (typeof value !== "string" || (!optional && !value) || value.includes("\0"))
    throw new TypeError("invalid actor factory identifier or port");
  for (let i = 0; i < value.length; i++) {
    const cp = value.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      if (++i >= value.length || value.charCodeAt(i) < 0xdc00 ||
          value.charCodeAt(i) > 0xdfff)
        throw new TypeError("malformed actor factory Unicode");
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      throw new TypeError("malformed actor factory Unicode");
    }
  }
  if (encoder.encode(value).length > MAX_FIELD_BYTES)
    throw new RangeError("actor factory metadata byte budget");
}

function snapshotStage(input) {
  const result = Object.freeze({
    id: ownData(input, "id"),
    actorType: ownData(input, "actorType"),
    role: ownData(input, "role"),
    inbound: ownData(input, "inbound"),
    outbound: ownData(input, "outbound")
  });
  checkedName(result.id);
  checkedName(result.actorType);
  checkedName(result.inbound, true);
  checkedName(result.outbound, true);
  const inputPort = !!result.inbound, outputPort = !!result.outbound;
  const valid = (result.role === "readable" && !inputPort && outputPort) ||
    (result.role === "writable" && inputPort && !outputPort) ||
    ((result.role === "transform" || result.role === "duplex") &&
      inputPort && outputPort);
  if (!valid) throw new TypeError("invalid actor factory stage role");
  return result;
}

export function planActorPipeFactory(stages, generation = 1) {
  // A factory expression is a *linear* typed chain. An existing graph may
  // also branch, but that is not silently inferred from vararg order.
  if (!Array.isArray(stages) || stages.length < 2 ||
      stages.length > MAX_STAGE_COUNT)
    throw new RangeError("actor factory stage budget");
  const count = stages.length;
  const snapshot = new Array(count), seen = new Set();
  for (let i = 0; i < count; i++) {
    const entry = snapshotStage(ownData(stages, String(i)));
    if (seen.has(entry.id))
      throw new TypeError("duplicate actor instance");
    seen.add(entry.id);
    snapshot[i] = entry;
  }
  if (snapshot[0].role !== "readable" ||
      snapshot[count - 1].role !== "writable")
    throw new TypeError("linear actor factory requires a source and sink");
  const edges = new Array(count - 1);
  for (let i = 0; i < count - 1; i++)
    edges[i] = planActorConnectEdge(snapshot[i], snapshot[i + 1]);
  // Delegate full graph validation (unique IDs, cycle rules, generation,
  // required ports) to the existing audited host-only selector.
  const selector = new ActorPipelineSelector(snapshot, edges, generation);
  return Object.freeze({
    stages: Object.freeze(snapshot),
    edges: Object.freeze(edges),
    generation,
    selector
  });
}

export function planActorConnectEdge(source, target) {
  // Static edge shape only: a REAL Actor.connect must separately check
  // ActorRef incarnations, authority, tenant, lifecycle and admission quotas.
  const from = snapshotStage(source), to = snapshotStage(target);
  if (from.id === to.id || !from.outbound || !to.inbound ||
      from.outbound !== to.inbound)
    throw new TypeError("incompatible actor factory connection");
  return Object.freeze({
    source: from.id,
    target: to.id,
    payload: from.outbound
  });
}
