// Symbolic compiler requirement only. Concrete runtime execution and region
// generations must be materialized later from authenticated scheduler state.
export function stateRegionRequirement(record) {
  if (record === null || typeof record !== "object") {
    throw new TypeError("state-region requirement record required");
  }
  if (record.contractVersion !== "1.0") {
    throw new TypeError("unsupported state-region requirement version");
  }
  if (typeof record.regionBinding !== "string" ||
      record.regionBinding.trim().length === 0) {
    throw new TypeError("state-region requirement needs a region binding");
  }
  if (record.executionBinding !== "current-logical-execution") {
    throw new TypeError("state-region requirement must bind current logical execution");
  }
  if (record.generationFence !== true) {
    throw new TypeError("state-region requirement must be generation fenced");
  }
  if (!Number.isSafeInteger(record.loanId) || record.loanId <= 0) {
    throw new TypeError("state-region requirement loanId must be positive");
  }
  if (typeof record.place !== "string" || record.place.trim().length === 0) {
    throw new TypeError("state-region requirement needs a nonblank place");
  }
  if (record.kind !== "read" && record.kind !== "write") {
    throw new TypeError("invalid state-region requirement access kind");
  }
  if (record.action !== "borrow" && record.action !== "release") {
    throw new TypeError("invalid state-region requirement action");
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
    regionBinding: record.regionBinding,
    executionBinding: "current-logical-execution",
    generationFence: true,
    loanId: record.loanId,
    place: record.place,
    kind: record.kind,
    action: record.action
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
