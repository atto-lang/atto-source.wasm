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
  const forbidden = new Set([
    "regionId", "regionGeneration", "runtimeDomain", "executionId",
    "executionSlot", "executionGeneration"
  ]);
  // One atomic-looking descriptor snapshot avoids re-reading guest-facing
  // objects through Proxy get traps between validation and normalization.
  // It is a validated receipt, never a capability granting heap access.
  const descriptors = Object.getOwnPropertyDescriptors(record);
  for (const name of Reflect.ownKeys(descriptors)) {
    if (forbidden.has(name)) {
      throw new TypeError("compile-time requirement must not contain " + name);
    }
    if (!allowedFields.includes(name)) {
      throw new TypeError("unknown state-region requirement field: " + String(name));
    }
  }
  for (const name of allowedFields) {
    const descriptor = descriptors[name];
    if (!descriptor) {
      throw new TypeError("missing own state-region requirement field: " + name);
    }
    if (!Object.hasOwn(descriptor, "value")) {
      throw new TypeError("state-region requirement accessor forbidden: " + name);
    }
  }
  const value = name => descriptors[name].value;
  if (value("contractVersion") !== "1.0") {
    throw new TypeError("unsupported state-region requirement version");
  }
  if (typeof value("regionBinding") !== "string" ||
      value("regionBinding").trim().length === 0) {
    throw new TypeError("state-region requirement needs a region binding");
  }
  if (value("executionBinding") !== "current-logical-execution") {
    throw new TypeError("state-region requirement must bind current logical execution");
  }
  if (value("generationFence") !== true) {
    throw new TypeError("state-region requirement must be generation fenced");
  }
  if (!Number.isSafeInteger(value("loanId")) || value("loanId") <= 0) {
    throw new TypeError("state-region requirement loanId must be positive");
  }
  if (typeof value("place") !== "string" || value("place").trim().length === 0) {
    throw new TypeError("state-region requirement needs a nonblank place");
  }
  if (value("kind") !== "read" && value("kind") !== "write") {
    throw new TypeError("invalid state-region requirement access kind");
  }
  if (value("action") !== "borrow" && value("action") !== "release") {
    throw new TypeError("invalid state-region requirement action");
  }

  return Object.freeze({
    contractVersion: "1.0",
    regionBinding: value("regionBinding"),
    executionBinding: "current-logical-execution",
    generationFence: true,
    loanId: value("loanId"),
    place: value("place"),
    kind: value("kind"),
    action: value("action")
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
