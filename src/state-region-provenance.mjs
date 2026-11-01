// Concrete host/runtime-materialized provenance only. Compiler IR must use
// state-region-requirement.mjs semantics instead of fabricating execution IDs.
// This object never grants guest access to WebAssembly linear memory and must
// not be used as a runtime capability.
const fields = Object.freeze([
  "regionId", "regionGeneration", "runtimeDomain", "executionId",
  "executionSlot", "executionGeneration", "loanId"
]);

// JSON Schema declares additionalProperties=false. Copying a known subset
// must not silently bless a record carrying arbitrary guest memory authority.
const allowedFields = new Set(["contractVersion", ...fields, "place", "kind", "action"]);
function snapshotProvenance(record) {
  // Own-property descriptors are the validated data, not record[field].
  // A Proxy can return honest descriptors while trapping later property gets.
  // The receipt never performs those later gets.
  const descriptors = Object.getOwnPropertyDescriptors(record);
  for (const name of Reflect.ownKeys(descriptors)) {
    if (!allowedFields.has(name)) {
      throw new TypeError("unknown state-region provenance field: " + String(name));
    }
  }
  for (const name of allowedFields) {
    const descriptor = Object.getOwnPropertyDescriptor(descriptors, name)?.value;
    if (!descriptor) {
      throw new TypeError("missing own state-region provenance field: " + name);
    }
    if (!Object.hasOwn(descriptor, "value")) {
      throw new TypeError("state-region provenance accessor forbidden: " + name);
    }
  }
  return descriptors;
}

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(name + " must be a positive safe integer");
  }
  return value;
}

export function stateRegionProvenance(record) {
  if (record === null || typeof record !== "object") {
    throw new TypeError("state-region provenance record required");
  }
  // Only JSON-style plain records, never class instances or inherited
  // capability-bearing views, may cross this host provenance boundary.
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("plain state-region provenance record required");
  }
  // Take a single descriptor snapshot. Never use record[field] afterward:
  // Proxy get traps are NOT ownership authority, and may run guest code.
  const descriptors = snapshotProvenance(record);
  const value = name => descriptors[name].value;
  if (value("contractVersion") !== "1.0") {
    throw new TypeError("unsupported state-region provenance version");
  }
  const out = {contractVersion: "1.0"};
  for (const name of fields) out[name] = positiveSafeInteger(value(name), name);
  if (typeof value("place") !== "string" || value("place").trim().length === 0) {
    throw new TypeError("state-region provenance requires a nonblank place");
  }
  if (value("kind") !== "read" && value("kind") !== "write") {
    throw new TypeError("invalid state-region access kind");
  }
  if (value("action") !== "borrow" && value("action") !== "release") {
    throw new TypeError("invalid state-region loan action");
  }
  out.place = value("place");
  out.kind = value("kind");
  out.action = value("action");
  return Object.freeze(out);
}

export function stateRegionAuthorizesRelease(borrowInput, releaseInput) {
  const borrow = stateRegionProvenance(borrowInput);
  const release = stateRegionProvenance(releaseInput);
  if (borrow.action !== "borrow" || release.action !== "release") return false;
  return fields.every(name => borrow[name] === release[name]) &&
    borrow.place === release.place &&
    borrow.kind === release.kind;
}

export function stateRegionReleaseRecord(borrowInput) {
  const borrow = stateRegionProvenance(borrowInput);
  if (borrow.action !== "borrow") {
    throw new TypeError("only a borrow record can derive a release record");
  }
  return stateRegionProvenance({...borrow, action: "release"});
}
