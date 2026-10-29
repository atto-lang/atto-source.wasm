import test from "node:test";
import assert from "node:assert/strict";
import {assertZeroCapabilityOptions, compileAdmittedCoreGuest} from "../src/guest-admission.mjs";

// Invalid bytes deliberately prove option rejection precedes guest compilation.
const BAD_GUEST = Uint8Array.of(0);
test("no ignored guest broker, unsafe, host-import or network capability option", () => {
  for (const key of ["guestFileIo", "unsafe", "ffi", "capabilityIoBroker",
                     "hostCapabilities", "networkPermission", "allowActorIo",
                     "nativeSocket", "actorPermissions", "untrustedBroker"]) {
    assert.throws(() => compileAdmittedCoreGuest(BAD_GUEST, {[key]: true}),
      /unsupported WASM guest capability\/option/);
  }
});
test("only strict zero capability values are admitted", () => {
  for (const [key,bad] of [
    ["guestNetworkIo", 0], ["guestNetworkIo", "false"],
    ["nioReactors", false], ["nioReactors", "0"],
    ["actorPhysicalTurns", 1], ["hardRealtime", 0]
  ]) assert.throws(() => compileAdmittedCoreGuest(BAD_GUEST, {[key]: bad}),
    /unsupported WASM guest capability/);
  assert.doesNotThrow(() => assertZeroCapabilityOptions({
    guestNetworkIo:false, nioReactors:0, actorPhysicalTurns:0, hardRealtime:false}));
});
test("inherited settings, accessors and symbols cannot hide capabilities", () => {
  assert.throws(() => assertZeroCapabilityOptions(Object.create({guestNetworkIo:true})),
    /plain option data/);
  const getter = {};
  Object.defineProperty(getter, "guestNetworkIo", {
    get() {throw Error("getter executed");}, enumerable:true
  });
  assert.throws(() => assertZeroCapabilityOptions(getter), /getters\/setters/);
  const symbol = {[Symbol("net")]: true};
  assert.throws(() => assertZeroCapabilityOptions(symbol), /unsupported WASM/);
});

test("validated snapshot cannot be mutated or swapped by a malicious Proxy", () => {
  let secondRead = 0;
  const hostile = new Proxy({guestNetworkIo:false}, {
    get(target, property) {
      if (property === "guestNetworkIo") {
        ++secondRead;
        return true; // would escalate if the checked object were re-read
      }
      return Reflect.get(target, property);
    },
  });
  const checked = assertZeroCapabilityOptions(hostile);
  assert.equal(checked.guestNetworkIo, false);
  assert.equal(Object.isFrozen(checked), true);
  assert.equal(Object.getPrototypeOf(checked), null);
  assert.throws(() => compileAdmittedCoreGuest(BAD_GUEST, hostile));
  assert.equal(secondRead, 0, "guest option values must come from one descriptor snapshot");
});

test("a proxy cannot smuggle privileged options via a second descriptor read", () => {
  let descriptorReads = 0;
  const hostile = new Proxy({guestNetworkIo:false}, {
    getOwnPropertyDescriptor(target, key) {
      ++descriptorReads;
      return Reflect.getOwnPropertyDescriptor(target,key);
    },
    get(_target,key) {
      if (key === "guestNetworkIo") throw Error("unvalidated property getter executed");
    },
  });
  const checked = assertZeroCapabilityOptions(hostile);
  assert.equal(checked.guestNetworkIo, false);
  assert.ok(descriptorReads > 0);
});
