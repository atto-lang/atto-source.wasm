// Source-model differential tests only; NOT compiler/linker/guest evidence.
// Run with: node --test tests/udp-policy-source-model.test.mjs
// Keep this in each backend repository; do NOT import a shared canonical library.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../stdlib/net/udp.atto", import.meta.url), "utf8");
const fixtures = ["udp-policy-main.atto", "udp-boundary-adversarial.atto"];
const MAX = 9223372036854775807n;

function toModel(text) {
  // Deliberately narrow: only the portable, pure .atto fnc slice is supported.
  const cleaned = text.replace(/\/\/[^\n]*/g, "");
  if (/\b(import|require|eval|class|actor|while|for|new)\b/.test(cleaned))
    throw new Error("UDP source model refuses imports, objects, loops and host calls");
  const model = cleaned
    .replace(/\bpub fnc (\w+)\(([^)]*)\): (?:bool|int) \{/g,
      (_, name, parameters) => "function " + name + "(" +
        parameters.split(",").map(p => p.trim().split(/\s+/).at(-1)).filter(Boolean).join(",") + ") {")
    .replace(/\blet (\w+): int =/g, "let $1 =")
    .replace(/\bif (.*?) then return (.*?); fi/g, (_, condition, result) =>
      "if (" + condition + ") { return " + result + "; }")
    .replace(/(?<![A-Za-z_])([0-9]+)(?![A-Za-z_])/g, "$1n");
  if (/\b(?:pub|fnc|then|fi)\b/.test(model))
    throw new Error("Unsupported .atto syntax in pure UDP source model");
  // This is a hermetic V8 model, NOT a lowering step from an Atto compiler.
  return model;
}

function execute(model) {
  const sandbox = Object.create(null);
  runInNewContext(model, sandbox, { timeout: 2000 });
  return sandbox;
}

test("two pure-Atto fixtures return 42 in the BigInt source model", () => {
  for (const fixture of fixtures) {
    const file = readFileSync(new URL("./fixtures/" + fixture, import.meta.url), "utf8");
    const count = (file.match(/\bif /g) ?? []).length;
    assert.equal(count, 41, fixture + " must retain all 41 checks");
    const actual = execute(toModel(source) + "\n" + toModel(file));
    assert.equal(actual.main(), 42n, fixture);
  }
});

const families = [0n, 4n, 6n, 7n];
const values = [-1n, 0n, 1n, 2n, 9n, 10n, 255n, 65507n, 65508n,
  65527n, 65528n, 65535n, 65536n, 65537n, MAX - 1n, MAX];
let state = 0x107de3c5;
function pick(items) {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return items[state % items.length];
}
function protocol(family) { return family === 4n ? 65507n : family === 6n ? 65527n : -1n; }
function payload(bytes, app, path, family) {
  return bytes >= 0n && app >= 0n && path >= 0n && protocol(family) >= 0n &&
    bytes <= protocol(family) && bytes <= app && bytes <= path;
}
function queue(used, bytes, max) {
  return used >= 0n && bytes >= 0n && max >= 0n &&
    used <= max && bytes <= max - used;
}
function stream(packets, used, bytes, packetCap, byteCap, family) {
  return packetCap > 0n && packetCap <= 65536n && byteCap > 0n &&
    packets >= 0n && packets < packetCap && used >= 0n && bytes >= 0n &&
    payload(bytes, byteCap, byteCap, family) && queue(used, bytes, byteCap);
}
function release(packets, used, bytes) {
  return packets > 0n && used >= 0n && bytes >= 0n && bytes <= used;
}
function send(family, port, bytes, app, path) {
  return (family === 4n || family === 6n) && port > 0n && port <= 65535n &&
    payload(bytes, app, path, family);
}

test("2,048 deterministic differential cases against independent mathematical oracle", () => {
  const c = execute(toModel(source));
  for (let i = 0; i < 2048; ++i) {
    const a = pick(values), b = pick(values), d = pick(values);
    const e = pick(values), f = pick(values), family = pick(families);
    assert.equal(c.udp_queue_can_enqueue(a, b, d), queue(a, b, d), "queue case " + i);
    assert.equal(c.udp_stream_can_enqueue(a, b, d, e, f, family),
      stream(a, b, d, e, f, family), "stream case " + i);
    assert.equal(c.udp_stream_can_release(a, b, d), release(a, b, d), "release case " + i);
    assert.equal(c.udp_send_to_admissible(family, a, b, d, e),
      send(family, a, b, d, e), "send case " + i);
    assert.equal(c.udp_dropped_next(a),
      a < 0n ? -1n : a >= 2147483647n ? 2147483647n : a + 1n,
      "drop case " + i);
  }
});

test("negative mutation demonstrates that the differential test can fail", () => {
  const before = "return payload_bytes <= max_bytes - current_bytes;";
  assert.ok(source.includes(before), "expected bounded subtraction missing");
  const damaged = source.replace(before, "return true;");
  const original = execute(toModel(source));
  const mutant = execute(toModel(damaged));
  assert.equal(original.udp_queue_can_enqueue(9n, 2n, 10n), false);
  assert.equal(mutant.udp_queue_can_enqueue(9n, 2n, 10n), true);
});
