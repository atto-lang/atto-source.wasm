import test from "node:test";
import assert from "node:assert/strict";
import {compileAdmittedCoreGuest} from "../src/guest-admission.mjs";

// Intentionally malformed core guest: unsupported capabilities must fail
// BEFORE Wasm decoding/instantiation, so no guest bytes or host imports run.
const neverAdmitted = new Uint8Array([0]);

const cases = [
  [{ioMode: "legacy-compat"}, /legacy\/blocking host I\/O/],
  [{ioMode: "blocking"}, /legacy\/blocking host I\/O/],
  [{ioMode: null}, /legacy\/blocking host I\/O/],
  [{guestNetworkIo: true}, /guest NIO is not implemented/],
  [{guestNetworkIo: "false"}, /guest NIO is not implemented/],
  [{nioReactors: 1}, /reactor threads are unsupported/],
  [{nioReactors: 4}, /reactor threads are unsupported/],
  [{nioReactors: -1}, /reactor threads are unsupported/],
  [{actorPhysicalTurns: 1}, /physical source actor execution is unsupported/],
  [{actorPhysicalTurns: 3}, /physical source actor execution is unsupported/],
  [{actorPhysicalTurns: -1}, /physical source actor execution is unsupported/],
  [{hardRealtime: true}, /hard-real-time scheduling is unsupported/],
  [{hardRealtime: "false"}, /hard-real-time scheduling is unsupported/]
];
test("core-wasm denies unsupported guest NIO, reactor and actor execution explicitly", () => {
  for (const [options, pattern] of cases) {
    assert.throws(() => compileAdmittedCoreGuest(neverAdmitted, options), pattern);
  }
});
test("WASM default remains scalar-only and does not fake network/actors", () => {
  // With no prohibited options, admission proceeds to normal Wasm byte
  // validation; failure must be due to the malformed module itself.
  assert.throws(() => compileAdmittedCoreGuest(neverAdmitted),
    error => !/NIO|reactor threads|physical source actor|hard-real-time|legacy/.test(error.message));
});


test("unsupported TCP pooling and shared pointers reject before decoding any Wasm", () => {
  const forbidden = [
    {sharedTcpPool: true}, {sharedTcpPool: 1}, {sharedTcpPool: null},
    {tcpPoolLeaseCount: 1}, {tcpPoolLeaseCount: -1},
    {tcpPoolLeaseCount: "0"}, {tcpPoolLeaseCount: Number.NaN},
    {tcpPoolPointerSharing: true}, {tcpPoolPointerSharing: "false"},
    {sharedTcpPool: false, tcpPoolLeaseCount: 1},
    {tcpSocketPool: true}, {tcpPoolLeases: 4},
    {socketPool: 2}, {sharedTcpLease: true},
    {connectionPoolPointer: "unsafe"}
  ];
  for (const options of forbidden) {
    assert.throws(
      () => compileAdmittedCoreGuest(neverAdmitted, options),
      /shared TCP pool\/lease\/pointer capability is unsupported/,
      JSON.stringify(options)
    );
  }
  // Explicitly inactive capabilities must not change core scalar admission.
  assert.throws(
    () => compileAdmittedCoreGuest(neverAdmitted, {
      sharedTcpPool: false, tcpPoolLeaseCount: 0, tcpPoolPointerSharing: false
    }),
    error => !/shared TCP pool\/lease\/pointer/.test(error.message));
});
