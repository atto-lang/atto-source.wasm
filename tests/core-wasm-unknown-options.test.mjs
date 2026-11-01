import test from "node:test";
import assert from "node:assert/strict";
import {compileAdmittedCoreGuest} from "../src/guest-admission.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";

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
