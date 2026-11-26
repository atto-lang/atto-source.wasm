import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {types} from "node:util";
import {admitCoreGuest, compileAdmittedCoreGuest} from "../src/guest-admission.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";

// These tests deliberately use invalid guest bytes: invalid options must be
// rejected BEFORE any guest snapshot, compilation, worker or host I/O.
function forbiddenOptions() {
  let accessorRuns = 0;
  const getter = Object.defineProperty({}, "entry", {
    enumerable: true, get() { accessorRuns++; return "main"; }
  });
  return {
    getAccessorRuns: () => accessorRuns,
    values: [
      {permissions: {net: ["api.example.com:443"]}},
      {allowNet: ["api.example.com:443"]},
      Object.defineProperty({}, "allowRead", {value: ["/workspace"], enumerable: false}),
      {[Symbol("allowFfi")]: true},
      getter,
      Object.create({allowRun: ["git"]}),
      Object.create({entry: "main"}),
      ["entry"],
      42,
      null
    ]
  };
}

test("admission API rejects hidden, symbol, inherited, accessor host options", () => {
  const {values, getAccessorRuns} = forbiddenOptions();
  for (const options of values) {
    assert.throws(() => admitCoreGuest(null, options),
      /zero-capability guest option|guest options must/);
    assert.throws(() => compileAdmittedCoreGuest(null, options),
      /zero-capability guest option|guest options must/);
  }
  assert.equal(getAccessorRuns(), 0, "no user-controlled accessors executed");
});

test("isolated runner rejects hidden and inherited permissions before starting worker", async () => {
  const {values, getAccessorRuns} = forbiddenOptions();
  for (const options of values) {
    await assert.rejects(runIsolatedCoreGuest(null, options),
      /zero-capability guest option|guest options must/);
  }
  assert.equal(getAccessorRuns(), 0, "no option getters executed");
});

test("valid supported options retain normal snapshot validation path", async () => {
  const options = Object.assign(Object.create(null), {entry: "main"});
  assert.throws(() => admitCoreGuest(null, options), /expected core WebAssembly bytes/);
  await assert.rejects(runIsolatedCoreGuest(null, {timeoutMs: 1000}),
    /expected core WebAssembly bytes/);
});

test("hidden known options are rejected by all guest APIs", async () => {
  // A name on the allowlist is not sufficient: invisible descriptor metadata
  // must not silently change options in an otherwise ordinary options object.
  for (const [key, value] of [
    ["entry", "main"], ["maxMemoryPages", 2], ["maxModuleBytes", 65536],
    ["expectedSha256", "0".repeat(64)]
  ]) {
    for (const prototype of [Object.prototype, null]) {
      const options = Object.defineProperty(Object.create(prototype), key, {
        value, enumerable: false, configurable: true
      });
      assert.throws(() => admitCoreGuest(null, options), /non-enumerable/);
      assert.throws(() => compileAdmittedCoreGuest(null, options), /non-enumerable/);
      await assert.rejects(runIsolatedCoreGuest(null, options), /non-enumerable/);
    }
  }
  const timeout = Object.defineProperty({}, "timeoutMs", {
    value: 1000, enumerable: false
  });
  await assert.rejects(runIsolatedCoreGuest(null, timeout), /non-enumerable/);
  // Public data descriptors are still accepted up to the normal byte check.
  assert.throws(() => admitCoreGuest(null, {entry: "main"}),
    /expected core WebAssembly bytes/);
});

test("prototype-polluted normal options fail before guest compilation", async () => {
  const original = Object.getOwnPropertyDescriptor(Object.prototype, "allowNet");
  Object.defineProperty(Object.prototype, "allowNet", {
    configurable: true, value: ["api.example.com:443"]
  });
  try {
    assert.throws(() => admitCoreGuest(null, {}), /inherited settings/);
    await assert.rejects(runIsolatedCoreGuest(null, {}), /inherited settings/);
    // Null-prototype options remain isolated from Object.prototype.
    assert.throws(() => admitCoreGuest(null, Object.create(null)),
      /expected core WebAssembly bytes/);
  } finally {
    if (original) Object.defineProperty(Object.prototype, "allowNet", original);
    else delete Object.prototype.allowNet;
  }
});

test("proxy options cannot trigger prototype or property inspection traps", async () => {
  let traps = 0;
  const dangerous = new Proxy({}, {
    getPrototypeOf() { traps++; throw Error("getPrototypeOf trap executed"); },
    ownKeys() { traps++; throw Error("ownKeys trap executed"); },
    getOwnPropertyDescriptor() {
      traps++; throw Error("getOwnPropertyDescriptor trap executed");
    },
    get() { traps++; throw Error("get trap executed"); }
  });
  assert.throws(() => admitCoreGuest(null, dangerous), /option proxies are forbidden/);
  assert.throws(() => compileAdmittedCoreGuest(null, dangerous),
    /option proxies are forbidden/);
  await assert.rejects(runIsolatedCoreGuest(null, dangerous),
    /option proxies are forbidden/);
  assert.equal(traps, 0, "no user-controlled Proxy traps were invoked");
});

test("revoked proxies are rejected without their traps", async () => {
  const {proxy, revoke} = Proxy.revocable({}, {});
  revoke();
  assert.throws(() => admitCoreGuest(null, proxy), /option proxies are forbidden/);
  await assert.rejects(runIsolatedCoreGuest(null, proxy),
    /option proxies are forbidden/);
});

test("cross-realm proxy options cannot reach malicious traps", async () => {
  const foreignProxy = vm.runInNewContext(
    'new Proxy({entry:"main"}, { getPrototypeOf() { throw Error("foreign trap executed"); } })'
  );
  assert.throws(() => admitCoreGuest(null, foreignProxy), /option proxies are forbidden/);
  await assert.rejects(runIsolatedCoreGuest(null, foreignProxy),
    /option proxies are forbidden/);
});

test("invalid known identity types never invoke caller coercion", async () => {
  let coerced = 0;
  const malicious = {
    toString() { coerced++; throw Error("option coercion executed"); },
    [Symbol.toPrimitive]() { coerced++; throw Error("option coercion executed"); }
  };
  for (const [key, expected] of [
    ["entry", /invalid guest entry/],
    ["expectedSha256", /invalid pinned SHA-256/]
  ]) {
    assert.throws(() => admitCoreGuest(null, {[key]: malicious}), expected);
    await assert.rejects(runIsolatedCoreGuest(null, {[key]: malicious}), expected);
  }
  assert.equal(coerced, 0, "host option values must not execute custom coercion");
});

test("only isolated runner admits the timeout option", () => {
  assert.throws(() => admitCoreGuest(null, {timeoutMs: 1000}),
    /unsupported zero-capability guest option/);
});

test("host monkeypatches do not disable the proxy guard", () => {
  // The host process may load other code after this module imports the
  // validator. A patched exported util.types method must not revive traps.
  let traps = 0;
  const dangerous = new Proxy({}, {
    getPrototypeOf() { traps++; throw Error("hostile proxy trap executed"); }
  });
  const original = types.isProxy;
  try {
    types.isProxy = () => false;
    assert.throws(() => admitCoreGuest(null, dangerous), /option proxies are forbidden/);
    assert.throws(() => compileAdmittedCoreGuest(null, dangerous),
      /option proxies are forbidden/);
    assert.equal(traps, 0, "no proxy traps should execute");
  } finally {
    types.isProxy = original;
  }
});

test("host monkeypatches cannot make unsupported permissions appear valid", () => {
  const original = Array.prototype.includes;
  try {
    Array.prototype.includes = () => true;
    assert.throws(() => admitCoreGuest(null, {allowNet: ["*"]}),
      /unsupported zero-capability guest option/);
    assert.throws(() => compileAdmittedCoreGuest(null, {permissions: {net: ["*"]}}),
      /unsupported zero-capability guest option/);
  } finally {
    Array.prototype.includes = original;
  }
});

test("host monkeypatches cannot hide inherited permission metadata", () => {
  const originalSome = Array.prototype.some;
  const originalDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "allowNet");
  try {
    Object.defineProperty(Object.prototype, "allowNet", {
      value: ["*"], configurable: true
    });
    Array.prototype.some = () => false;
    assert.throws(() => admitCoreGuest(null, {}),
      /zero-capability guest options must have no inherited settings/);
    assert.throws(() => compileAdmittedCoreGuest(null, {}),
      /zero-capability guest options must have no inherited settings/);
  } finally {
    Array.prototype.some = originalSome;
    if (originalDescriptor) Object.defineProperty(Object.prototype, "allowNet", originalDescriptor);
    else delete Object.prototype.allowNet;
  }
});

test("late overrides of reflection intrinsics cannot change admission", () => {
  const originalPrototype = Object.getPrototypeOf;
  const originalDescriptors = Object.getOwnPropertyDescriptors;
  const originalKeys = Reflect.ownKeys;
  try {
    Object.getPrototypeOf = () => { throw Error("patched prototype inspection"); };
    Object.getOwnPropertyDescriptors = () => { throw Error("patched descriptors"); };
    Reflect.ownKeys = () => { throw Error("patched keys inspection"); };
    assert.throws(() => admitCoreGuest(null, {entry: "main"}),
      /expected core WebAssembly bytes/);
  } finally {
    Object.getPrototypeOf = originalPrototype;
    Object.getOwnPropertyDescriptors = originalDescriptors;
    Reflect.ownKeys = originalKeys;
  }
});

test("overriding Set.has cannot hide inherited authorization", () => {
  const originalHas = Set.prototype.has;
  const originalDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "allowRun");
  try {
    Object.defineProperty(Object.prototype, "allowRun", {
      value: ["*"], configurable: true
    });
    Set.prototype.has = () => true;
    assert.throws(() => admitCoreGuest(null, {}),
      /zero-capability guest options must have no inherited settings/);
  } finally {
    Set.prototype.has = originalHas;
    if (originalDescriptor) Object.defineProperty(Object.prototype, "allowRun", originalDescriptor);
    else delete Object.prototype.allowRun;
  }
});
