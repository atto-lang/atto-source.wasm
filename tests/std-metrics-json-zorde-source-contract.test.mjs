// Source contract audit only: DOES NOT compile or execute Atto guest code.
// Run: node --test tests/std-metrics-json-zorde-source-contract.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = p => readFileSync(path.join(repo, p), "utf8");
const modules = {
  metrics: read("stdlib/std/metrics.atto"),
  json: read("stdlib/std/json.atto"),
  zorde: read("stdlib/std/zorde.atto"),
};

function stripComments(s) {
  return s.split("\n").map(line => line.replace(/\/\/.*$/, "")).join("\n");
}

test("three independent native Atto hosted modules, no host interop", () => {
  for (const [name, content] of Object.entries(modules)) {
    assert.match(content, new RegExp("define module " + name + " as"));
    const source = stripComments(content);
    assert.doesNotMatch(source, /\bjava:|\bSystem\.|\bHostInterop\.|\bffi\.|\bNativeIo\./);
    assert.doesNotMatch(source, /\bawait\s|\bstdio\.|\bnetwork\.|\bprocess\./);
    assert.ok(content.length > 100);
  }
});

test("JSON parser has explicit numeric, Unicode, duplicate-key and quota guards", () => {
  const json = modules.json;
  for (const invariant of [
    "keys_equal", "hex4", "55296", "56319", "56320", "57343",
    "1048576", "262144", "keys.size >= 128",
    "capture", "read_string(false)", "read_string(true)", "key_comparisons >= 65536",
    "IntegerRange", "floor = -9223372036854775807",
    "if negative; do floor = floor - 1; fi",
    "decode_i32", "parse(String text)", "stringify(Document document)",
  ]) assert.ok(json.includes(invariant), "JSON safeguard missing: " + invariant);
});

test("Zorde varuint and frame admission reject ambiguity before exposure", () => {
  const z = modules.zorde;
  for (const invariant of [
    "NonCanonicalVaruint", "VaruintOverflow", "TruncatedVaruint",
    "checked_reader", "checked_writer",
    "value > 2147483647", "schema_id > 2147483647",
    "encoded = (-value - 1) * 2 + 1;",
    "write_length_delimited", "read_length_delimited",
    "self.position = start", "InvalidWireByte", "WrongSchema",
    "UnsupportedSchemaVersion", "length != r.remaining()",
    "encode_bool_frame", "decode_bool_frame",
    "encode_i31_frame", "decode_i31_frame",
  ]) assert.ok(z.includes(invariant), "Zorde safeguard missing: " + invariant);
});

test("Metrics counters and histograms explicitly reject unsafe updates", () => {
  const m = modules.metrics;
  for (const invariant of [
    "ceiling - self.current", "amount < 0",
    "self.samples == 2147483647", "2147483647 - self.total",
    "self.rejected < 2147483647", "bounds.size > 64",
    "value <= bounds.get(i - 1)", "bucket_count",
    "CounterSnapshot", "GaugeSnapshot", "HistogramSnapshot", "copied_counts",
  ]) assert.ok(m.includes(invariant), "metrics safeguard missing: " + invariant);
});

test("backend-owned staged modules are present but not guest execution", () => {
  for (const name of Object.keys(modules)) {
    assert.ok(existsSync(path.join(repo, "stdlib/std/" + name + ".atto")));
    assert.doesNotMatch(modules[name], /GUEST_(EXECUTED|PASS)=true/);
  }
});

test("deterministic Zorde v1 little wire reference vectors (source-free oracle)", () => {
  const varuint = n => {
    assert.ok(Number.isSafeInteger(n) && n >= 0 && n <= 2147483647);
    const out = [];
    while (n >= 128) { out.push((n % 128) + 128); n = Math.floor(n / 128); }
    out.push(n);
    return out;
  };
  const frame = (id, version, payload) =>
    [90, 79, 82, 68, 1, ...varuint(id), ...varuint(version), ...varuint(payload.length), ...payload];
  assert.deepEqual(frame(7, 1, [0, 255]), [90,79,82,68,1,7,1,2,0,255]);
  assert.deepEqual(frame(42, 2, [1]), [90,79,82,68,1,42,2,1,1]);
  assert.deepEqual(varuint(2147483647), [255,255,255,255,7]);
  assert.deepEqual(varuint(2147483646), [254,255,255,255,7]);
});


test("portable signed JSON integer scalar vectors (source-free reference)", () => {
  const vectors = JSON.parse(read("contracts/std-metrics-json-zorde-source-v1.json"));
  assert.equal(vectors.schema, "atto.stdlib.metrics-json-zorde.source-v1");
  const min = -(1n << 63n);
  const max = (1n << 63n) - 1n;
  for (const { raw, admit } of vectors.json.signed_integer_scalars) {
    const lexical = /^-?(?:0|[1-9][0-9]*)$/.test(raw);
    const inRange = lexical && BigInt(raw) >= min && BigInt(raw) <= max;
    assert.equal(inRange, admit, "signed JSON integer: " + raw);
  }
});

test("canonical varuint31 + ZigZag31 contract vectors (source-free reference)", () => {
  const { zorde } = JSON.parse(read("contracts/std-metrics-json-zorde-source-v1.json"));
  const encode = input => {
    if (!Number.isSafeInteger(input) || input < 0 || input > 2147483647) return null;
    const bytes = [];
    let value = input;
    do {
      const digit = value % 128;
      value = Math.floor(value / 128);
      bytes.push(digit + (value > 0 ? 128 : 0));
    } while (value > 0);
    return bytes;
  };
  const decode = bytes => {
    let value = 0, multiplier = 1;
    for (let i = 0; i < 5; i++) {
      if (i >= bytes.length) return null;
      const octet = bytes[i];
      if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
      const digit = octet % 128;
      if (i === 4 && (digit > 7 || octet >= 128)) return null;
      if (i > 0 && digit === 0 && octet < 128) return null;
      value += digit * multiplier;
      if (octet < 128) return { value, consumed: i + 1 };
      multiplier *= 128;
    }
    return null;
  };
  for (const { value, wire } of zorde.valid_varuint31) {
    assert.deepEqual(encode(value), wire, "varuint31 encoding " + value);
    assert.deepEqual(decode(wire), { value, consumed: wire.length });
  }
  for (const { wire } of zorde.invalid_varuint31) {
    assert.equal(decode(wire), null, "reject ambiguous varuint " + wire);
  }
  for (const { value, wire } of zorde.signed_zigzag31) {
    const zigzag = value < 0 ? (-value - 1) * 2 + 1 : value * 2;
    assert.deepEqual(encode(zigzag), wire, "ZigZag31 " + value);
    const decoded = decode(wire)?.value;
    assert.equal(decoded % 2 ? -Math.floor(decoded / 2) - 1 : decoded / 2, value);
  }
  assert.equal(encode(2147483648), null);
});

test("bootstrap envelope vectors and bounded metric aggregation (reference only)", () => {
  const { zorde, metrics } = JSON.parse(read("contracts/std-metrics-json-zorde-source-v1.json"));
  const varuint = value => {
    const bytes = [];
    do { const digit = value % 128; value = Math.floor(value / 128);
      bytes.push(digit + (value > 0 ? 128 : 0)); } while (value > 0);
    return bytes;
  };
  for (const { schema_id, schema_version, payload, wire } of zorde.frames) {
    const encoded = [90,79,82,68,1, ...varuint(schema_id),
      ...varuint(schema_version), ...varuint(payload.length), ...payload];
    assert.deepEqual(encoded, wire);
  }
  const h = metrics.histogram;
  const counts = new Array(h.inclusive_bounds.length + 1).fill(0);
  let accepted = 0, rejected = 0, sum = 0;
  for (const value of h.observations) {
    if (value < 0 || sum + value > 2147483647) { rejected++; continue; }
    const slot = h.inclusive_bounds.findIndex(bound => value <= bound);
    counts[slot < 0 ? counts.length - 1 : slot]++;
    accepted++; sum += value;
  }
  assert.deepEqual({ accepted, rejected, sum, bucket_counts: counts }, {
    accepted: h.accepted, rejected: h.rejected, sum: h.sum, bucket_counts: h.bucket_counts
  });
});


test("three identical Atto guest fixtures have pinned nonempty 127-line goldens", () => {
  const evidence = JSON.parse(read("tests/fixtures/std-metrics-json-zorde/expected-stdout.json"));
  assert.equal(evidence.schema, "atto.stdlib.metrics-json-zorde.guest-stdout-v1");
  assert.equal(evidence.status, "REFERENCE_NOT_EXECUTED_ON_THIS_BACKEND");
  let outputs = 0;
  for (const [name, expected] of Object.entries({metrics:36,json:36,zorde:55})) {
    const vector = evidence.fixtures[name];
    assert.equal(vector.path,"tests/fixtures/std-metrics-json-zorde/"+name+".atto");
    assert.equal(vector.stdout_lines.length,expected);
    const source = read(vector.path);
    assert.equal((source.match(/stdio\.println\(/g)||[]).length,expected);
    outputs += expected;
  }
  assert.equal(outputs,127);
});
