// SOURCE-ONLY admission: parse a restricted pure-policy subset of backend-owned
// Atto .atto source. No JavaScript result is an Atto compiler/guest receipt.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";

if (process.env.ATTO_REQUIRE_NATIVE_GUEST === "1") {
  throw new Error("NATIVE_GUEST_NOT_EXECUTED: this Node source checker is not a backend compiler");
}
const contractPath = new URL("../contracts/atto-std-pure-policy-parity-v1.json", import.meta.url);
const backendNames = ["path", "sync", "telemetry"];
function bytesFrom(url) {
  const path = url.pathname;
  const stat = lstatSync(url);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), path + " must be a regular source");
  const bytes = readFileSync(url);
  assert.ok(bytes.length > 0 && bytes.length < 1048576, path + " bounded size");
  const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assert.ok(!value.includes("\0") && !value.includes("\r") &&
    !value.startsWith("\ufeff") && value.endsWith("\n"),
    path + " strict UTF-8/LF");
  return { bytes, value };
}
function blob(bytes) {
  return createHash("sha1").update(Buffer.from("blob " + bytes.length + "\0"))
    .update(bytes).digest("hex");
}
const contractInput = bytesFrom(contractPath);
const EXPECTED_CONTRACT_BLOB = "3d9e9d5308a4cd0a99d811570f8c80e77b7219b7";
assert.equal(blob(contractInput.bytes), EXPECTED_CONTRACT_BLOB,
  "shared behavioral vectors changed without a reviewed version bump");
const contract = JSON.parse(contractInput.value);
assert.equal(contract.schema, "atto-std-pure-policy-parity-v1");
assert.equal(contract.status, "CANDIDATE_ONLY; NOT_EXECUTED via native guest");
assert.deepEqual(Object.keys(contract.api), backendNames);
assert.equal(contract.vectors.length, 134);
assert.equal(contract.backends.length, 11);
const sourceInputs = Object.fromEntries(backendNames.map(name =>
  [name, bytesFrom(new URL("../stdlib/std/" + name + ".atto", import.meta.url))]));
const sourceBlobs = Object.fromEntries(backendNames.map(name =>
  [name, blob(sourceInputs[name].bytes)]));

// Restrict the source model to expressions and straight-line early-return
// conditions only; reject any statement that the tiny model would silently drop.
function compilePureModule(input, api, moduleName) {
  const withoutComments = input.replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(withoutComments, /\b(?:import|new|await|throw|rt|ffi|asm|class)\b|java:|csharp:|do-java/,
    "no host or privileged authority in " + moduleName);
  const pattern = /^pub fnc ([a-z_][a-z0-9_]*)\(([\s\S]*?)\): (int|bool) \{([\s\S]*?)^\}/gm;
  const matches = [...withoutComments.matchAll(pattern)];
  assert.equal(withoutComments.replace(pattern, "").trim(), "",
    moduleName + " must be entirely parsed as plain native Atto function definitions");
  assert.deepEqual(matches.map(m => m[1]).sort(),
    Object.keys(api).sort(), moduleName + " missing/duplicate/unexpected APIs");
  const compiled = [];
  for (const match of matches) {
    const [_, name, rawArgs, returns, rawBody] = match;
    const params = rawArgs.split(",").map(a => a.trim()).filter(Boolean).map(a => {
      const typed = /^(int|bool) ([a-z_][a-z0-9_]*)$/.exec(a);
      assert.ok(typed, "unsupported typed formal " + name + " " + a);
      return { type: typed[1], name: typed[2] };
    });
    assert.deepEqual([...params.map(p => p.type), returns], api[name],
      moduleName + "." + name + " public signature drift");
    const body = rawBody.replace(/if\s+([\s\S]*?)\s+then\s+return\s+([^;]+);\s*fi/g,
      (_, condition, result) => "if (" + condition.trim() + ") return " + result.trim() + ";");
    assert.doesNotMatch(body, /\b(?:then|fi|while|for|do|function|let|const)\b|[{}]/,
      name + " outside supported source-only interpreter subset");
    const validNames = new Set(["if", "return", "true", "false", ...params.map(p => p.name)]);
    for (const identifier of body.matchAll(/[a-z_][a-z0-9_]*/g))
      assert.ok(validNames.has(identifier[0]),
        name + " uses unknown token " + identifier[0]);
    const remainder = body.replace(/[a-z_][a-z0-9_]*/g, "")
      .replace(/\d+/g, "").replace(/[+*\/%<>=!&|;(),\-\s]/g, "");
    assert.equal(remainder, "", name + " contains unsupported syntax");
    compiled.push("function " + name + "(" + params.map(p => p.name).join(",") +
      ") {" + body + "}");
  }
  const names = matches.map(m => m[1]);
  return runInNewContext(compiled.join("\n") + "\n({" + names.join(",") + "})",
    Object.create(null), { timeout: 1500 });
}
function verify(inputs = sourceInputs) {
  const implementations = Object.fromEntries(backendNames.map(name =>
    [name, compilePureModule(inputs[name].value, contract.api[name], name)]));
  for (const [index, vector] of contract.vectors.entries()) {
    assert.equal(vector.id, "STD-" + String(index + 1).padStart(3, "0"),
      "closed vector ID sequence");
    const signature = contract.api[vector.module]?.[vector.fn];
    assert.ok(signature, "unknown contract function " + vector.id);
    assert.equal(vector.args.length + 1, signature.length, "arity " + vector.id);
    for (const [i, value] of vector.args.entries())
      assert.equal(typeof value, signature[i] === "bool" ? "boolean" : "number",
        "argument type " + vector.id);
    assert.equal(typeof vector.expected, signature.at(-1) === "bool" ? "boolean" : "number",
      "expected result type " + vector.id);
    const actual = implementations[vector.module][vector.fn](...vector.args);
    assert.equal(actual, vector.expected, vector.id +
      " " + vector.module + "." + vector.fn + "(" + vector.args.join(",") + ")");
  }
  return contract.vectors.length;
}
function assertMutantRejected(label, mutation) {
  assert.throws(() => verify(mutation), undefined, label + " mutation must be rejected");
}
test("pure native .atto policy candidate matches all 134 source-model vectors", () => {
  assert.equal(verify(), 134);
  console.log("ATTO_STD_SOURCE_MODEL_ONLY|cases=134|native_guest=NOT_EXECUTED" +
    "|contract_blob=" + EXPECTED_CONTRACT_BLOB +
    "|source_blobs=" + JSON.stringify(sourceBlobs));
});
test("five negative admission mutations fail closed", () => {
  const alter = (module, oldText, newText) => {
    const original = sourceInputs[module].value;
    assert.ok(original.includes(oldText), "mutant anchor " + oldText);
    return { ...sourceInputs,
      [module]: { value: original.replace(oldText, newText) } };
  };
  assertMutantRejected("missing public API",
    alter("path", "pub fnc is_separator", "fnc is_separator"));
  assertMutantRejected("inverted slash policy",
    alter("path", "return scalar == 47 || (windows && scalar == 92);", "return false;"));
  assertMutantRejected("illegal semaphore behavior",
    alter("sync", "return released >= 1 && released <= capacity - available;",
      "return released >= 0 && released <= capacity - available;"));
  assertMutantRejected("sample bit inversion",
    alter("telemetry", "return flags >= 0 && flags <= 255 && flags % 2 == 1;",
      "return flags >= 0 && flags <= 255 && flags % 2 == 0;"));
  assertMutantRejected("injected host code",
    alter("telemetry", "pub fnc sampled_flag", "java:evil\npub fnc sampled_flag"));
});
