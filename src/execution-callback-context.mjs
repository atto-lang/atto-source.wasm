const BOUNDARIES = new Set([
  "HOST_CALLBACK",
  "IO",
  "TIMER",
  "AWAIT",
  "ACTOR_MESSAGE",
  "SUPERVISOR_CONTROL",
  "TASK_JOIN",
  "SPAWN",
]);

const MAX_TRACE_BOUNDARIES = 8;

const CALLBACK_FIELDS = [
  "kind",
  "runtimeDomain",
  "execution",
  "dispatch",
  "generation",
  "parentExecution",
  "continuation",
  "boundary",
  "traceBoundaries",
  "traceElided",
];
const CALLBACK_FIELD_SET = new Set(CALLBACK_FIELDS);
const EXECUTION_FIELDS = CALLBACK_FIELDS.slice(0, 7);
const EXECUTION_FIELD_SET = new Set(EXECUTION_FIELDS);
const canonicalCallbacks = new WeakSet();

// Frozen accessors are still executable and may return different values on
// successive reads. Copy own data descriptors, never property values via Get.
function snapshotRecord(value, fields, fieldSet, label) {
  if (!value || typeof value !== "object") throw new TypeError(`invalid Ores ${label} context`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== fields.length || keys.some(key => !fieldSet.has(key))) {
    throw new TypeError(`${label} context contains unexpected fields`);
  }
  const snapshot = Object.create(null);
  for (const key of fields) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label} context requires own data fields`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function snapshotTrace(value, boundary, elided) {
  if (!Array.isArray(value)) throw new TypeError("invalid callback trace boundary history");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isInteger(length) || length < 1 || length > MAX_TRACE_BOUNDARIES
      || Reflect.ownKeys(descriptors).length !== length + 1) {
    throw new TypeError("invalid callback trace boundary history");
  }
  const trace = [];
  for (let i = 0; i < length; i++) {
    const descriptor = descriptors[String(i)];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !BOUNDARIES.has(descriptor.value)) {
      throw new TypeError("invalid callback trace boundary history");
    }
    trace.push(descriptor.value);
  }
  if (trace[length - 1] !== boundary || (elided > 0n && length !== MAX_TRACE_BOUNDARIES)) {
    throw new TypeError("invalid callback trace boundary history");
  }
  return Object.freeze(trace);
}

function freezeCallback(value) {
  const frozen = Object.freeze(value);
  canonicalCallbacks.add(frozen);
  return frozen;
}

let currentCallbackContext = null;

function asPositiveBigInt(value, field) {
  if (typeof value !== "bigint" || value <= 0n) {
    throw new TypeError(`${field} must be a positive bigint`);
  }
  return value;
}

function asNonNegativeBigInt(value, field) {
  if (typeof value !== "bigint" || value < 0n) {
    throw new TypeError(`${field} must be a non-negative bigint`);
  }
  return value;
}

export function createExecutionContext({
  runtimeDomain,
  execution,
  dispatch,
  generation,
  parentExecution = 0n,
  continuation = 0n,
}) {
  return Object.freeze({
    kind: "ores.execution.v1",
    runtimeDomain: asPositiveBigInt(runtimeDomain, "runtimeDomain"),
    execution: asPositiveBigInt(execution, "execution"),
    dispatch: asPositiveBigInt(dispatch, "dispatch"),
    generation: asPositiveBigInt(generation, "generation"),
    parentExecution: asNonNegativeBigInt(parentExecution, "parentExecution"),
    continuation: asNonNegativeBigInt(continuation, "continuation"),
  });
}

function validateExecution(value) {
  if (!value) throw new TypeError("explicit Ores execution context is required");
  const snapshot = snapshotRecord(value, EXECUTION_FIELDS, EXECUTION_FIELD_SET, "execution");
  if (snapshot.kind !== "ores.execution.v1") {
    throw new TypeError("explicit Ores execution context is required");
  }
  return createExecutionContext(snapshot);
}

function validateCallback(value) {
  // Only records created by this module can take the identity fast path.
  if (canonicalCallbacks.has(value)) return value;
  const snapshot = snapshotRecord(value, CALLBACK_FIELDS, CALLBACK_FIELD_SET, "callback");
  if (snapshot.kind !== "ores.callback.v1") throw new TypeError("invalid Ores callback context");
  if (!BOUNDARIES.has(snapshot.boundary)) throw new TypeError("invalid Ores callback boundary");
  asPositiveBigInt(snapshot.runtimeDomain, "runtimeDomain");
  asPositiveBigInt(snapshot.execution, "execution");
  asPositiveBigInt(snapshot.dispatch, "dispatch");
  asPositiveBigInt(snapshot.generation, "generation");
  asNonNegativeBigInt(snapshot.parentExecution, "parentExecution");
  asNonNegativeBigInt(snapshot.continuation, "continuation");
  asNonNegativeBigInt(snapshot.traceElided, "traceElided");
  snapshot.traceBoundaries = snapshotTrace(snapshot.traceBoundaries, snapshot.boundary, snapshot.traceElided);
  return freezeCallback({ ...snapshot });
}

/**
 * Capture is explicit. No Node AsyncLocalStorage, worker-global state, or
 * producer event-loop ambient value is consulted for execution authority.
 */
export function captureExecutionCallbackContext(activeExecution, boundary) {
  if (!BOUNDARIES.has(boundary)) {
    throw new TypeError("invalid Ores callback boundary");
  }
  const active = validateExecution(activeExecution);
  return freezeCallback({
    kind: "ores.callback.v1",
    runtimeDomain: active.runtimeDomain,
    execution: active.execution,
    dispatch: active.dispatch,
    generation: active.generation,
    parentExecution: active.parentExecution,
    continuation: active.continuation,
    boundary,
    traceBoundaries: Object.freeze([boundary]),
    traceElided: 0n,
  });
}

export function deriveExecutionCallbackContext(parentContext, boundary) {
  if (!BOUNDARIES.has(boundary)) {
    throw new TypeError("invalid Ores callback boundary");
  }
  const parent = validateCallback(parentContext);
  const trace = [...parent.traceBoundaries, boundary];
  let traceElided = parent.traceElided;
  while (trace.length > MAX_TRACE_BOUNDARIES) {
    trace.shift();
    traceElided += 1n;
  }

  return freezeCallback({
    kind: "ores.callback.v1",
    runtimeDomain: parent.runtimeDomain,
    execution: parent.execution,
    dispatch: parent.dispatch,
    generation: parent.generation,
    parentExecution: parent.parentExecution,
    continuation: parent.continuation,
    boundary,
    traceBoundaries: Object.freeze(trace),
    traceElided,
  });
}

/**
 * Install provenance only for synchronous host bookkeeping. The scope is
 * always restored before control returns to the event loop, including throws.
 * This module intentionally exposes no guest-entry or actor-memory capability.
 */
export function runWithExecutionCallbackContext(context, fn) {
  const captured = validateCallback(context);
  if (typeof fn !== "function") throw new TypeError("callback body must be a function");

  const previous = currentCallbackContext;
  currentCallbackContext = captured;
  try {
    return fn();
  } finally {
    currentCallbackContext = previous;
  }
}

export function currentExecutionCallbackContext() {
  return currentCallbackContext;
}

export function isExecutionCallbackContext(value) {
  try {
    validateCallback(value);
    return true;
  } catch {
    return false;
  }
}
