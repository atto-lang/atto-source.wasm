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

const CALLBACK_FIELDS = [
  "kind",
  "runtimeDomain",
  "execution",
  "dispatch",
  "generation",
  "parentExecution",
  "continuation",
  "boundary",
];
const CALLBACK_FIELD_SET = new Set(CALLBACK_FIELDS);

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
  if (!value || value.kind !== "ores.execution.v1") {
    throw new TypeError("explicit Ores execution context is required");
  }
  createExecutionContext(value);
  return value;
}

function validateCallback(value) {
  if (!value || value.kind !== "ores.callback.v1") {
    throw new TypeError("invalid Ores callback context");
  }

  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== CALLBACK_FIELDS.length ||
    keys.some((key) => typeof key !== "string" || !CALLBACK_FIELD_SET.has(key))
  ) {
    throw new TypeError("callback context contains unexpected fields");
  }

  if (!BOUNDARIES.has(value.boundary)) {
    throw new TypeError("invalid Ores callback boundary");
  }
  asPositiveBigInt(value.runtimeDomain, "runtimeDomain");
  asPositiveBigInt(value.execution, "execution");
  asPositiveBigInt(value.dispatch, "dispatch");
  asPositiveBigInt(value.generation, "generation");
  asNonNegativeBigInt(value.parentExecution, "parentExecution");
  asNonNegativeBigInt(value.continuation, "continuation");

  if (Object.isFrozen(value)) return value;
  return Object.freeze({
    kind: "ores.callback.v1",
    runtimeDomain: value.runtimeDomain,
    execution: value.execution,
    dispatch: value.dispatch,
    generation: value.generation,
    parentExecution: value.parentExecution,
    continuation: value.continuation,
    boundary: value.boundary,
  });
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
  return Object.freeze({
    kind: "ores.callback.v1",
    runtimeDomain: active.runtimeDomain,
    execution: active.execution,
    dispatch: active.dispatch,
    generation: active.generation,
    parentExecution: active.parentExecution,
    continuation: active.continuation,
    boundary,
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
