import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const CONTRACT_URL = new URL("../contracts/v1/native-math-unary-precision-v1.json", import.meta.url);
const EXPECTED_GIT_BLOB = "3249d837ae6bcf6e2c2c23cac872becf92d0c8e0";
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

function gitBlobSha(bytes) {
  return createHash("sha1")
    .update(Buffer.from("blob " + bytes.length + "\0", "ascii"))
    .update(bytes)
    .digest("hex");
}

function evalI64(operation, text) {
  const value = BigInt(text);
  assert.ok(value >= I64_MIN && value <= I64_MAX);
  if (operation === "Math.neg") {
    return value === I64_MIN ? {error: "OVERFLOW"} : {value: String(-value)};
  }
  if (operation === "Math.abs") {
    return value === I64_MIN
      ? {error: "OVERFLOW"}
      : {value: String(value < 0n ? -value : value)};
  }
  throw new Error("unknown operation");
}

function fromBits(hex) {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setBigUint64(0, BigInt("0x" + hex), false);
  return view.getFloat64(0, false);
}

function toBits(value) {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, false);
  return view.getBigUint64(0, false).toString(16).padStart(16, "0");
}

test("native Math unary/precision contract is byte-pinned and internally exact", async () => {
  const bytes = await readFile(CONTRACT_URL);
  assert.equal(gitBlobSha(bytes), EXPECTED_GIT_BLOB);
  const contract = JSON.parse(bytes.toString("utf8"));
  assert.equal(contract.contract, "oreslang.native-math-unary-precision.v1");
  assert.equal(contract.status, "normative-reference-not-backend-proof");

  const ids = [];
  for (const group of ["signed_i64_unary", "bigint_unary", "decimal_unary",
                       "binary64_unary", "precision_cases"]) {
    for (const item of contract[group]) ids.push(item.id);
  }
  assert.equal(new Set(ids).size, ids.length);

  for (const item of contract.signed_i64_unary) {
    assert.deepEqual(evalI64(item.operation, item.operand), item.expect, item.id);
  }
  for (const item of contract.bigint_unary) {
    const value = BigInt(item.operand);
    const actual = item.operation === "Math.neg" ? -value : (value < 0n ? -value : value);
    assert.equal(String(actual), item.expect, item.id);
  }
  for (const item of contract.binary64_unary) {
    const input = fromBits(item.operand_bits);
    const actual = item.operation === "Math.abs" ? Math.abs(input) : -input;
    assert.equal(toBits(actual), item.expect_bits, item.id);
  }

  const above53 = contract.precision_cases.find(x => x.id === "bigint-above-2pow53");
  assert.equal(BigInt(above53.value), 9007199254740993n);
  assert.notEqual(BigInt(Math.trunc(Number(above53.value))), BigInt(above53.value),
    "JS Number must not be used as the i64/BigInt carrier");

  const binary = contract.precision_cases.find(
    x => x.id === "binary64-point-one-plus-point-two");
  assert.equal(String(Number(binary.lhs) + Number(binary.rhs)),
    binary.must_equal_decimal_string);
});

test("Wasm bootstrap does not claim unsupported BigInt/Decimal Math lowering", async () => {
  const backend = JSON.parse(await readFile(
    new URL("../contracts/v1/numeric-parity/backend.json", import.meta.url), "utf8"));
  for (const capability of ["bigint_exact", "decimal_exact", "binary32_arithmetic"]) {
    assert.notEqual(backend.capabilities[capability], "verified_compiled",
      capability + " must remain fail-closed without real guest execution");
  }
});
