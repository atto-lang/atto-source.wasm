import test from "node:test";
import assert from "node:assert/strict";
import {compileAdmittedCoreGuest} from "../src/guest-admission.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";
import {assertKnownCoreWasmOptions} from "../src/core-wasm-options.mjs";

const unsupported = [
  "tenantId", "tenant", "isolateId", "actorId", "permissions",
  "capabilities", "wasmtimeStore", "actorPlacement"
];

test("scalar guest admission rejects every unsupported tenant/capability authority", () => {
  for (const key of unsupported) {
    assert.throws(() => compileAdmittedCoreGuest(null, {[key]: "tenant-a"}),
      /unsupported core Wasm guest admission option/, key);
  }
});

test("Node worker refuses unsupported tenant/capability authorities before starting", async () => {
  for (const key of unsupported) {
    await assert.rejects(runIsolatedCoreGuest(null, {[key]: "tenant-a"}),
      /unsupported core Wasm isolated runner option/, key);
  }
});

test("nonenumerable and symbol placement options cannot bypass admission", async () => {
  const hidden = {};
  Object.defineProperty(hidden, "tenantId", {value: "tenant-a", enumerable: false});
  const symbol = {[Symbol("tenantId")]: "tenant-a"};
  for (const options of [hidden, symbol]) {
    assert.throws(() => compileAdmittedCoreGuest(null, options),
      /unsupported core Wasm guest admission option/);
    await assert.rejects(runIsolatedCoreGuest(null, options),
      /unsupported core Wasm isolated runner option/);
  }
});

test("known scalar options still progress to ordinary input validation", async () => {
  assert.throws(() => compileAdmittedCoreGuest(null, {entry: "main"}),
    /expected core WebAssembly bytes/);
  await assert.rejects(runIsolatedCoreGuest(null, {timeoutMs: 100}),
    /expected core WebAssembly bytes/);
});

test("malformed options fail before byte admission", async () => {
  for (const options of [null, [], "tenant-a"]) {
    assert.throws(() => compileAdmittedCoreGuest(null, options),
      /options must be an object/);
    await assert.rejects(runIsolatedCoreGuest(null, options),
      /options must be an object/);
  }
});

test("mixed supported and forbidden options fail before visiting bytes", async () => {
  for (const forbidden of unsupported) {
    const options = {entry: "main", [forbidden]: null};
    assert.throws(() => compileAdmittedCoreGuest(null, options),
      new RegExp("unsupported core Wasm guest admission option: " + forbidden), forbidden);
    await assert.rejects(runIsolatedCoreGuest(null, options),
      new RegExp("unsupported core Wasm isolated runner option: " + forbidden), forbidden);
  }
});

test("only data descriptors are allowed: getters must not run", async () => {
  let invoked = 0;
  const getter = {};
  Object.defineProperty(getter, "entry", {
    enumerable: true,
    get() { invoked++; throw new Error("executed forbidden option getter"); }
  });
  assert.throws(() => compileAdmittedCoreGuest(null, getter),
    /option must be a data property: entry/);
  await assert.rejects(runIsolatedCoreGuest(null, getter),
    /option must be a data property: entry/);
  assert.equal(invoked, 0, "admission must not evaluate a getter");

  const setter = {};
  Object.defineProperty(setter, "entry", {
    enumerable: true,
    set(_) { invoked++; }
  });
  assert.throws(() => compileAdmittedCoreGuest(null, setter),
    /option must be a data property: entry/);
  await assert.rejects(runIsolatedCoreGuest(null, setter),
    /option must be a data property: entry/);
  assert.equal(invoked, 0);
});

test("malicious option prototypes are denied without inherited authority", async () => {
  const inherited = Object.create({tenantId: "other-tenant"});
  inherited.entry = "main";
  assert.throws(() => compileAdmittedCoreGuest(null, inherited),
    /plain data object/);
  await assert.rejects(runIsolatedCoreGuest(null, inherited),
    /plain data object/);
  const nullPrototype = Object.assign(Object.create(null), {entry: "main"});
  assert.throws(() => compileAdmittedCoreGuest(null, nullPrototype),
    /expected core WebAssembly bytes/);
  await assert.rejects(runIsolatedCoreGuest(null, nullPrototype),
    /expected core WebAssembly bytes/);
});

test("prototype-key spoofing and forbidden symbols cannot be smuggled", async () => {
  const spoof = {entry: "main"};
  Object.defineProperty(spoof, "__proto__", {
    configurable: true, enumerable: false, value: {tenantId: "spoof"}
  });
  for (const options of [spoof, {entry: "main", [Symbol.toStringTag]: "Tenant"}]) {
    assert.throws(() => compileAdmittedCoreGuest(null, options),
      /unsupported core Wasm guest admission option/);
    await assert.rejects(runIsolatedCoreGuest(null, options),
      /unsupported core Wasm isolated runner option/);
  }
});

test("supported descriptor values still require ordinary scalar validation", async () => {
  assert.throws(() => compileAdmittedCoreGuest(null, {ioMode: "blocking"}),
    /refuses legacy\/blocking host I\/O/);
  await assert.rejects(runIsolatedCoreGuest(null, {timeoutMs: 0}),
    /timeoutMs must be between 1 and 30000/);
});

test("Proxy option containers fail before invoking hostile traps", async () => {
  let traps = 0;
  const attack = new Proxy({}, {
    getPrototypeOf() { traps++; throw Error("proxy getPrototypeOf invoked"); },
    ownKeys() { traps++; throw Error("proxy ownKeys invoked"); },
    get() { traps++; throw Error("proxy get invoked"); }
  });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const options of [attack, revoked.proxy]) {
    assert.throws(() => compileAdmittedCoreGuest(null, options),
      /options cannot be Proxy objects/);
    await assert.rejects(runIsolatedCoreGuest(null, options),
      /options cannot be Proxy objects/);
  }
  assert.equal(traps, 0, "no Proxy traps invoked during option admission");
});

test("coercible option values cannot invoke attacker-defined conversion hooks", async () => {
  let coercions = 0;
  const value = {
    [Symbol.toPrimitive]() {
      coercions++;
      throw Error("unexpected hostile conversion");
    },
    toString() {
      coercions++;
      throw Error("unexpected hostile toString");
    }
  };
  const cases = [
    ["entry", value],
    ["expectedSha256", value],
    ["timeoutMs", value],
    ["maxMemoryPages", value],
    ["ioMode", value],
    ["hardRealtime", value],
    ["entry", Symbol("main")],
    ["expectedSha256", null]
  ];
  for (const [key, candidate] of cases) {
    assert.throws(() => compileAdmittedCoreGuest(null, {[key]: candidate}),
      new RegExp("option has invalid type: " + key));
    if (!["ioMode", "hardRealtime"].includes(key)) {
      await assert.rejects(runIsolatedCoreGuest(null, {[key]: candidate}),
        new RegExp("option has invalid type: " + key));
    }
  }
  assert.equal(coercions, 0, "no option conversion hooks executed");
});

test("recognized primitive option types retain existing optional defaults", async () => {
  assert.throws(() => compileAdmittedCoreGuest(null, {
    entry: undefined, maxMemoryPages: undefined,
    expectedSha256: undefined, hardRealtime: false
  }), /expected core WebAssembly bytes/);
  await assert.rejects(runIsolatedCoreGuest(null, {
    timeoutMs: undefined, entry: undefined, expectedSha256: undefined
  }), /expected core WebAssembly bytes/);
});

test("denied authority does not touch hostile input bytes or worker setup", async () => {
  let traps = 0;
  const hostileBytes = new Proxy({}, {
    get() { traps++; throw Error("input getter must not execute"); },
    getPrototypeOf() { traps++; throw Error("input prototype must not execute"); },
    ownKeys() { traps++; throw Error("input keys must not be read"); }
  });
  for (const option of [
    {tenantId: "tenant-1"},
    {capabilities: ["network"]},
    {isolateId: "isolate-1"},
    {permissions: {net: true}},
    {entry: "main", actorPlacement: "private"}
  ]) {
    assert.throws(() => compileAdmittedCoreGuest(hostileBytes, option),
      /unsupported core Wasm guest admission option/);
    await assert.rejects(runIsolatedCoreGuest(hostileBytes, option),
      /unsupported core Wasm isolated runner option/);
  }
  assert.equal(traps, 0, "invalid authority must reject before visiting guest bytes");
});

test("unsupported authority cannot hide behind an accepted value", async () => {
  const unsupportedSecurityKeys = [
    "isolation", "sandbox", "allowNet", "allowRead", "allowWrite",
    "tenantQuota", "actorHeap", "actorMailbox", "wasmtimeFuel",
    "wasi", "physicalActor", "workerPermissions"
  ];
  for (const key of unsupportedSecurityKeys) {
    assert.throws(() => compileAdmittedCoreGuest(null, {entry: "main", [key]: false}),
      new RegExp("unsupported core Wasm guest admission option: " + key));
    await assert.rejects(runIsolatedCoreGuest(null, {entry: "main", [key]: false}),
      new RegExp("unsupported core Wasm isolated runner option: " + key));
  }
});

test("approved options are copied to a null-prototype, own-data-only record", () => {
  const source = Object.create(null);
  Object.defineProperty(source, "entry", {
    enumerable: false, writable: true, value: "main"
  });
  source.maxMemoryPages = 2;
  const normalized = assertKnownCoreWasmOptions(source,
    ["entry", "maxMemoryPages"], "guest admission");
  assert.notEqual(normalized, source);
  assert.equal(Object.getPrototypeOf(normalized), null);
  assert.deepEqual(Reflect.ownKeys(normalized), ["entry", "maxMemoryPages"]);
  assert.equal(normalized.entry, "main");
  assert.equal(normalized.maxMemoryPages, 2);
  source.entry = "mutated";
  assert.equal(normalized.entry, "main",
    "caller mutations cannot change already-admitted option values");
});

test("inherited Object.prototype option getters cannot execute after admission", async () => {
  // The original own-key validator still allowed this: destructuring an
  // approved {} would run Object.prototype.entry's inherited getter.
  const prior = Object.getOwnPropertyDescriptor(Object.prototype, "entry");
  let calls = 0;
  Object.defineProperty(Object.prototype, "entry", {
    configurable: true,
    get() { calls++; throw new Error("inherited option getter executed"); }
  });
  let runnerRejection;
  try {
    assert.throws(() => compileAdmittedCoreGuest(null, {}),
      /expected core WebAssembly bytes/);
    // Keep the global-prototype change strictly synchronous. The async
    // function starts admission immediately; restore Object.prototype before
    // yielding to Node's test runner to avoid test-harness interference.
    runnerRejection = runIsolatedCoreGuest(null, {});
    assert.equal(calls, 0, "the worker and compiler must not read inherited entry");
  } finally {
    if (prior) Object.defineProperty(Object.prototype, "entry", prior);
    else delete Object.prototype.entry;
  }
  await assert.rejects(runnerRejection, /expected core WebAssembly bytes/);
});

test("normalized unknown-attribute keys never read inherited tenant authority", () => {
  const options = {entry: "main"};
  const normalized = assertKnownCoreWasmOptions(options, ["entry"], "guest admission");
  assert.equal(Object.hasOwn(normalized, "tenantId"), false);
  assert.equal("tenantId" in normalized, false);
  assert.equal(Object.getPrototypeOf(normalized), null);
});

test("malformed SHA pin fails before evaluating hostile guest input", async () => {
  let touched = 0;
  const hostile = new Proxy({}, {
    getPrototypeOf() { touched++; throw Error("untrusted input visited"); },
    get() { touched++; throw Error("untrusted input visited"); },
    ownKeys() { touched++; throw Error("untrusted input visited"); }
  });
  for (const invalid of ["", "deadbeef", "F".repeat(64), "z".repeat(64), "a".repeat(65)]) {
    assert.throws(() => compileAdmittedCoreGuest(hostile, {
      entry: "main", expectedSha256: invalid
    }), /invalid pinned SHA-256/);
    await assert.rejects(runIsolatedCoreGuest(hostile, {
      entry: "main", expectedSha256: invalid
    }), /invalid pinned SHA-256/);
  }
  assert.equal(touched, 0, "malformed artifact identity must not touch guest bytes");
});

test("valid SHA pin proceeds to canonical input validation", () => {
  assert.throws(() => compileAdmittedCoreGuest(null, {
    expectedSha256: "a".repeat(64)
  }), /expected core WebAssembly bytes/);
});
