// Source-free repository contract guard. No native compiler, guest or release attestation.
import test from "node:test";
import assert from "node:assert/strict";
import {lstatSync, readFileSync} from "node:fs";

const expected = {
  "schemaVersion": 1,
  "protocol": "oreslang-ecosystem-integration",
  "repository": "ores-truffle-oreslang/oreslang-source.wasm",
  "role": "compiler",
  "upstreams": [
    "oreslang-source.llvm",
    "oreslang-target-profiles",
    "oreslang-wasm"
  ],
  "evidence": "not-attested",
  "note": "Declared integration touchpoints only; no CI or runtime parity is asserted."
};
const dir = new URL("../.oreslang", import.meta.url);
const member = new URL("../.oreslang/integration.json", import.meta.url);
const canonical = obj => JSON.stringify(obj, null, 2) + "\n";

function check_member(bytes) {
  assert.ok(Buffer.isBuffer(bytes), "contract input must be bytes");
  assert.ok(bytes.length > 0 && bytes.length <= 65536, "contract is bounded");
  const raw = new TextDecoder("utf-8", {fatal:true, ignoreBOM:true}).decode(bytes);
  assert.ok(!raw.startsWith("\uFEFF"), "byte order mark is forbidden");
  const parsed = JSON.parse(raw);
  // Exact canonical bytes rule out duplicate/escaped JSON authority keys,
  // last-wins parsers, extra fields and key-order ambiguity.
  assert.equal(raw, canonical(parsed), "noncanonical or duplicate JSON authority");
  assert.deepEqual(parsed, expected, "compiler identity, roles and upstreams are pinned");
  return {consistent:true, evidence:"metadata-only", ciAttested:false, guestExecuted:false, backendParity:false};
}

test("committed compiler member is canonical and cannot claim execution", () => {
  const d = lstatSync(dir), f = lstatSync(member);
  assert.ok(d.isDirectory() && !d.isSymbolicLink(), "unexpected manifest directory link");
  assert.ok(f.isFile() && !f.isSymbolicLink() && f.nlink === 1, "manifest must be a single-linked file");
  assert.deepEqual(check_member(readFileSync(member)), {
    consistent:true, evidence:"metadata-only", ciAttested:false, guestExecuted:false, backendParity:false
  });
});

test("reject missing, replaced and duplicate authority, including escaped aliases", () => {
  const absent = structuredClone(expected);
  delete absent.repository;
  assert.throws(() => check_member(Buffer.from(canonical(absent))));
  assert.throws(() => check_member(Buffer.from(canonical({...expected,repository:"attacker/mirror"}))));
  const valid = canonical(expected);
  assert.throws(() => check_member(Buffer.from(valid.replace('"role": "compiler",', '"role": "host",\n  "role": "compiler",'))));
  assert.throws(() => check_member(Buffer.from(valid.replace('"role": "compiler",', '"\\u0072ole": "host",\n  "role": "compiler",'))));
  assert.throws(() => check_member(Buffer.from(canonical({...expected, verified:true}))));
});

test("reject omitted, reordered, duplicate and foreign upstream contracts", () => {
  for (const upstreams of [[],["oreslang-source.js"],[...expected.upstreams].reverse(),[...expected.upstreams,expected.upstreams[0]]]) {
    assert.throws(() => check_member(Buffer.from(canonical({...expected,upstreams}))));
  }
});

test("reject invented compiler/CI/guest/target release evidence", () => {
  for (const evidence of ["passed","verified","compiler-guest","physical-hardware",true,null]) {
    assert.throws(() => check_member(Buffer.from(canonical({...expected,evidence}))));
  }
  for (const role of ["host","conformance","tool"]) {
    assert.throws(() => check_member(Buffer.from(canonical({...expected,role}))));
  }
  assert.throws(() => check_member(Buffer.from(canonical({...expected,note:"Native parity certified"}))));
});

test("reject invalid UTF-8, BOM, oversized and noncanonical raw bytes", () => {
  const valid = Buffer.from(canonical(expected));
  assert.throws(() => check_member(Buffer.from([0xC3,0x28])));
  assert.throws(() => check_member(Buffer.concat([Buffer.from([0xEF,0xBB,0xBF]),valid])));
  assert.throws(() => check_member(Buffer.alloc(65537,0x20)));
  assert.throws(() => check_member(Buffer.concat([valid,Buffer.from(" ")])));
  assert.throws(() => check_member(Buffer.from(JSON.stringify(expected))));
});
