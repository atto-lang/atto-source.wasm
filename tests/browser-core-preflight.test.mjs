import test from "node:test";
import assert from "node:assert/strict";
import {webcrypto} from "node:crypto";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import {preflightBrowserCoreGuest} from "../src/browser-core-preflight.mjs";
import {snapshotGuestBytes} from "../src/snapshot-guest-bytes.mjs";

// Real, valid zero-import Wasm32 guest: private 1..2-page memory, main()->i64 42.
const wasm = Uint8Array.of(
  0,97,115,109,1,0,0,0,
  1,5,1,0x60,0,1,0x7e,
  3,2,1,0,
  5,4,1,1,1,2,
  7,17,2,4,109,97,105,110,0,0,6,109,101,109,111,114,121,2,0,
  10,6,1,4,0,0x42,42,0x0b
);
const pin = async bytes => Buffer.from(
  await webcrypto.subtle.digest("SHA-256", bytes)).toString("hex");

test("portable scanners and browser preflight contain no Node-only imports", () => {
  for(const filename of [
    "src/snapshot-guest-bytes.mjs",
    "src/browser-core-preflight.mjs",
    "scripts/inspect-core-memory.mjs",
    "scripts/core-i64-abi.mjs",
    "scripts/no-managed-wasm.mjs"
  ]){
    const source = readFileSync(new URL("../"+filename, import.meta.url), "utf8");
    assert.doesNotMatch(source, /(?:from\s*["']node:|import\s*\(\s*["']node:)/,
      filename+" must resolve as a browser ES module");
  }
});

test("pinned browser preflight compiles real wasm32 with zero imports", async () => {
  assert.ok(WebAssembly.validate(wasm), "guest fixture must be valid Wasm");
  const {module, admission} = await preflightBrowserCoreGuest(wasm, await pin(wasm));
  assert.ok(module instanceof WebAssembly.Module);
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.equal(admission.profile, "core-wasm.i64-v1");
  assert.equal(admission.imports, 0);
  assert.equal(admission.hostCapabilities, 0);
  assert.equal(admission.memoryMaximumPages, 2);
  // Node executes this module as a host-compatibility check, NOT proof of
  // browser Worker containment or native Wasmtime AOT.
  const guest = await WebAssembly.instantiate(module, {});
  assert.equal(guest.exports.main(), 42n);
});

test("pinned browser preflight rejects wrong pins and non-Wasm input", async () => {
  await assert.rejects(preflightBrowserCoreGuest(wasm, "0".repeat(64)),
    /SHA-256 pin mismatch/);
  await assert.rejects(preflightBrowserCoreGuest(wasm, undefined),
    /requires a pinned/);
  const malformed = Uint8Array.of(1,2,3);
  await assert.rejects(preflightBrowserCoreGuest(malformed, await pin(malformed)),
    /invalid core module header|invalid core/i);
});

test("browser snapshot keeps cross-realm views and denies shared backing", () => {
  const foreign = vm.runInNewContext("new Uint8Array([9,1,2,3,8]).subarray(1,4)");
  assert.deepEqual([...snapshotGuestBytes(foreign,3)],[1,2,3]);
  const alien = vm.runInNewContext("new DataView(new Uint8Array([9,4,5,8]).buffer,1,2)");
  assert.deepEqual([...snapshotGuestBytes(alien,2)],[4,5]);
  if(typeof SharedArrayBuffer === "function") {
    const shared = vm.runInNewContext("new Uint8Array(new SharedArrayBuffer(8))");
    assert.throws(() => snapshotGuestBytes(shared,8), /SharedArrayBuffer-backed/);
  }
});

test("browser snapshot rejects proxies without triggering caller property traps", () => {
  let triggered=0;
  const forged=new Proxy(new Uint8Array(4),{
    get() {triggered++;throw Error("untrusted getter");},
    getPrototypeOf() {triggered++;throw Error("untrusted prototype");}
  });
  assert.throws(() => snapshotGuestBytes(forged,4), /expected core WebAssembly bytes/);
  assert.equal(triggered,0);
});
