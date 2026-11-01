import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {fileURLToPath} from "node:url";
import {
  stateRegionAuthorizesRelease,
  stateRegionProvenance,
  stateRegionReleaseRecord
} from "../src/state-region-provenance.mjs";
import {
  stateRegionRequirement,
  stateRegionRequirementAuthorizesRelease
} from "../src/state-region-requirement.mjs";

const vectors = JSON.parse(fs.readFileSync(
  fileURLToPath(new URL("../contracts/v1/state-region-provenance-v1.json", import.meta.url)),
  "utf8"));

test("canonical state-region provenance vectors fail closed", () => {
  const borrow = stateRegionProvenance(vectors.borrow);
  assert.equal(vectors.invalidReleases.length, 9);
  assert.equal(stateRegionAuthorizesRelease(borrow, vectors.validRelease), true);
  for (const {name, release} of vectors.invalidReleases) {
    assert.equal(stateRegionAuthorizesRelease(borrow, release), false, name);
  }
});

test("derived release preserves exact identity but not borrow action", () => {
  const borrow = stateRegionProvenance(vectors.borrow);
  const release = stateRegionReleaseRecord(borrow);
  assert.equal(release.action, "release");
  assert.equal(stateRegionAuthorizesRelease(borrow, release), true);
  assert.throws(() => stateRegionReleaseRecord(release), /only a borrow/);
});

test("malformed or unsafe numeric provenance is rejected", () => {
  for (const patch of [
    {executionSlot: 0},
    {executionGeneration: 0},
    {regionId: -1},
    {loanId: 1.5},
    {executionId: Number.MAX_SAFE_INTEGER + 1},
    {place: " "},
    {kind: "exclusive"},
    {action: "drop"},
    {contractVersion: "2.0"}
  ]) {
    assert.throws(() => stateRegionProvenance({...vectors.borrow, ...patch}));
  }
});

test("schema additionalProperties=false rejects smuggled runtime memory authority", () => {
  for (const [name, value] of [
    ["memory", new ArrayBuffer(8)],
    ["buffer", new ArrayBuffer(8)],
    ["regionPointer", 1234],
    ["trusted", true]
  ]) {
    assert.throws(
      () => stateRegionProvenance({...vectors.borrow, [name]: value}),
      /unknown state-region provenance field/);
  }
  const borrowing = stateRegionProvenance(vectors.borrow);
  assert.equal(stateRegionAuthorizesRelease(
    borrowing, stateRegionReleaseRecord(borrowing)), true);
});

test("metadata record is immutable and does not expose actor linear memory", () => {
  const metadata = stateRegionProvenance(vectors.borrow);
  assert.equal(Object.isFrozen(metadata), true);
  assert.equal("buffer" in metadata, false);
  assert.equal("memory" in metadata, false);
  assert.throws(() => {
    metadata.executionGeneration = 999;
  }, TypeError);
});


test("compile-time requirement never contains concrete runtime identity", () => {
  const borrow = stateRegionRequirement({
    contractVersion: "1.0",
    regionBinding: "inventory",
    executionBinding: "current-logical-execution",
    generationFence: true,
    loanId: 501,
    place: "inventory.stock",
    kind: "write",
    action: "borrow"
  });
  const release = stateRegionRequirement({...borrow, action: "release"});
  assert.equal(stateRegionRequirementAuthorizesRelease(borrow, release), true);

  for (const [field, value] of [
    ["regionId", 9],
    ["regionGeneration", 3],
    ["runtimeDomain", 7],
    ["executionId", 1001],
    ["executionSlot", 41],
    ["executionGeneration", 6]
  ]) {
    assert.throws(
      () => stateRegionRequirement({...borrow, [field]: value}),
      /must not contain/);
  }
  for (const [name, value] of [
    ["memory", new ArrayBuffer(8)],
    ["capability", true],
    ["runtimePointer", 7]
  ]) {
    assert.throws(
      () => stateRegionRequirement({...borrow, [name]: value}),
      /unknown state-region requirement field/);
  }
  assert.throws(
    () => stateRegionRequirement({...borrow, generationFence: false}),
    /generation fenced/);
});
