// Symbolic compiler requirement only. Concrete runtime execution and region
// generations must be materialized later from authenticated scheduler state.
export function stateRegionRequirement(record) {
  if (record === null || typeof record !== "object") {
    throw new TypeError("state-region requirement record required");
  }
  // No prototype-mediated or class-backed authority at compile time.
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("plain state-region requirement record required");
  }
  const allowedFields = [
    "contractVersion", "regionBinding", "executionBinding", "generationFence",
    "loanId", "place", "kind", "action"
  ];
  // Copy each required DATA descriptor exactly once. Never reread the source
  // record: a Proxy get trap can return valid text during validation and a
  // different identity when the compiled requirement is materialized.
  const snapshot = Object.create(null);
  for (const name of allowedFields) {
    const descriptor = Object.getOwnPropertyDescriptor(record, name);
    if (!descriptor) {
      throw new TypeError("missing own state-region requirement field: " + name);
    }
    if (!Object.hasOwn(descriptor, "value")) {
      throw new TypeError("state-region requirement accessor forbidden: " + name);
    }
    snapshot[name] = descriptor.value;
  }
  if (snapshot.contractVersion !== "1.0") {
    throw new TypeError("unsupported state-region requirement version");
  }
  if (typeof snapshot.regionBinding !== "string" ||
      snapshot.regionBinding.trim().length === 0) {
    throw new TypeError("state-region requirement needs a region binding");
  }
  if (snapshot.executionBinding !== "current-logical-execution") {
    throw new TypeError("state-region requirement must bind current logical execution");
  }
  if (snapshot.generationFence !== true) {
    throw new TypeError("state-region requirement must be generation fenced");
  }
  if (!Number.isSafeInteger(snapshot.loanId) || snapshot.loanId <= 0) {
    throw new TypeError("state-region requirement loanId must be positive");
  }
  if (typeof snapshot.place !== "string" || snapshot.place.trim().length === 0) {
    throw new TypeError("state-region requirement needs a nonblank place");
  }
  if (snapshot.kind !== "read" && snapshot.kind !== "write") {
    throw new TypeError("invalid state-region requirement access kind");
  }
  if (snapshot.action !== "borrow" && snapshot.action !== "release") {
    throw new TypeError("invalid state-region requirement action");
  }

  const allowed = new Set([
    "contractVersion", "regionBinding", "executionBinding", "generationFence",
    "loanId", "place", "kind", "action"
  ]);
  for (const name of Reflect.ownKeys(record)) {
    if (!allowed.has(name) && ![
      "regionId", "regionGeneration", "runtimeDomain", "executionId",
      "executionSlot", "executionGeneration"
    ].includes(name)) {
      throw new TypeError("unknown state-region requirement field: " + String(name));
    }
  }

  const forbidden = [
    "regionId", "regionGeneration", "runtimeDomain", "executionId",
    "executionSlot", "executionGeneration"
  ];
  for (const name of forbidden) {
    if (Object.hasOwn(record, name)) {
      throw new TypeError("compile-time requirement must not contain " + name);
    }
  }

  return Object.freeze({
    contractVersion: "1.0",
    regionBinding: snapshot.regionBinding,
    executionBinding: "current-logical-execution",
    generationFence: true,
    loanId: snapshot.loanId,
    place: snapshot.place,
    kind: snapshot.kind,
    action: snapshot.action
  });
}

export function stateRegionRequirementAuthorizesRelease(borrowInput, releaseInput) {
  const borrow = stateRegionRequirement(borrowInput);
  const release = stateRegionRequirement(releaseInput);
  return borrow.action === "borrow" && release.action === "release" &&
    borrow.regionBinding === release.regionBinding &&
    borrow.executionBinding === release.executionBinding &&
    borrow.generationFence === release.generationFence &&
    borrow.loanId === release.loanId &&
    borrow.place === release.place &&
    borrow.kind === release.kind;
}
