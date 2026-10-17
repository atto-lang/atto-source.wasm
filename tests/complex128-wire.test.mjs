import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {
  encodeComplex128Wire,
  decodeComplex128Wire,
  isCanonicalComplex128Wire
} from "../src/complex128-wire.mjs";

const vectors = [
  ["0000000000000000","8000000000000000",
   "00000000000000000000000000000080"],
  ["3ff0000000000000","c000000000000000",
   "000000000000f03f00000000000000c0"],
  ["0000000000000001","8000000000000001",
   "01000000000000000100000000000080"],
  ["7ff0000000000000","fff0000000000000",
   "000000000000f07f000000000000f0ff"],
  ["7ff8000000000042","fff8000000001234",
   "000000000000f87f000000000000f87f"]
];

test("complex128 host wire is exactly 16-byte real-first little-endian", () => {
  for (const [real, imaginary, hex] of vectors) {
    const encoded = encodeComplex128Wire(real, imaginary);
    assert.equal(encoded.byteLength, 16);
    assert.equal(Buffer.from(encoded).toString("hex"), hex);
  }
});

test("complex128 host wire round-trips signed zero, subnormals and infinities", () => {
  for (const [real, imaginary] of vectors.slice(0, 4)) {
    const decoded = decodeComplex128Wire(
      encodeComplex128Wire(real, imaginary));
    assert.deepEqual(decoded, {realBits:real, imaginaryBits:imaginary});
  }
});

test("complex128 host wire canonicalizes every NaN input", () => {
  for (const bits of [
    "7ff0000000000001",
    "7ff8000000000042",
    "fff0000000000001",
    "fff8000000001234"
  ]) {
    const decoded = decodeComplex128Wire(
      encodeComplex128Wire(bits, "0000000000000000"));
    assert.deepEqual(decoded, {
      realBits:"7ff8000000000000",
      imaginaryBits:"0000000000000000"
    });
  }
});

test("complex128 host decoder rejects noncanonical NaN wire values", () => {
  for (const hex of [
    "420000000000f87f0000000000000000",
    "000000000000f8ff0000000000000000",
    "0000000000000000341200000000f8ff"
  ]) {
    const bytes=Uint8Array.from(Buffer.from(hex,"hex"));
    assert.throws(() => decodeComplex128Wire(bytes), /noncanonical/);
    assert.equal(isCanonicalComplex128Wire(bytes), false);
  }
});

test("complex128 host decoder rejects wrong type and wrong length", () => {
  assert.throws(() => decodeComplex128Wire(new ArrayBuffer(16)), /Uint8Array/);
  for (const length of [0,1,15,17,32]) {
    assert.throws(() => decodeComplex128Wire(new Uint8Array(length)),
      /exactly 16 bytes/);
  }
});

test("actor serde contract still fails closed for complex until integration", async () => {
  const contract=JSON.parse(await readFile(
    new URL("../contracts/v1/serde_boundary_v1.json",import.meta.url),"utf8"));
  assert.ok(contract.wire_profile.unsupported_without_verified_runtime_codec
    .includes("complex"));
  assert.equal(
    contract.boundaries.actor_data.unimplemented_policy,
    "reject_before_enqueue");
});
