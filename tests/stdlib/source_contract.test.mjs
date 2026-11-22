// Source-level consistency audit. This is NOT an Atto compiler or runtime test.
// Requires node >= 18; operates on checked-out source, not generated snapshots.
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {resolve,dirname} from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const names = ["websocket", "quic", "compute"];
const sources = Object.fromEntries(names.map(name => [
  name, readFileSync(resolve(root, "stdlib/std", name + ".atto"), "utf8")
]));
const guest = readFileSync(resolve(root, "tests/stdlib/websocket_quic_compute_smoke.atto"), "utf8");

function verify(source, fixture) {
  const declared = Object.fromEntries(names.map(name => [
    name, new Set([...source[name].matchAll(/\bpub\s+fnc\s+([a-z][a-z0-9_]*)\s*\(/g)].map(m => m[1]))
  ]));
  assert.equal(names.reduce((n, name) => n + declared[name].size, 0), 42,
    "unexpected public Atto API count");
  for (const name of names) {
    assert.ok(source[name].includes("pub fnc "), name + " has no public Atto functions");
    assert.doesNotMatch(source[name], /%/, name + " contains removed Atto remainder operator");
    // Every helper call in a module must resolve to a function in the same module.
    for (const match of source[name].matchAll(new RegExp("\\b(" + name + "_[a-z0-9_]+)\\s*\\(", "g"))) {
      assert.ok(declared[name].has(match[1]), "unbound internal helper: " + match[1]);
    }
  }
  const isModule = /^\s*import\s+module\s+/m.test(fixture);
  if (isModule) {
    for (const name of names) {
      assert.match(source[name], new RegExp("\\bdefine pub module " + name + " as\\b"));
      assert.ok(fixture.includes('import module ' + name +
        ' from "+stdlib/std/' + name + '.atto";'), "module import missing: " + name);
    }
    for (const match of fixture.matchAll(/(?<![\w.])(?:websocket|quic|compute)_[a-z0-9_]+\s*\(/g)) {
      assert.fail("unqualified guest call bypasses required module import: " + match[0]);
    }
  } else {
    const imports = {};
    for (const match of fixture.matchAll(/import fnc ([\s\S]*?) from '\.\.\/\.\.\/stdlib\/std\/([a-z]+)';/g)) {
      assert.ok(names.includes(match[2]), "unexpected import " + match[2]);
      assert.equal(imports[match[2]], undefined, "duplicate import " + match[2]);
      imports[match[2]] = new Set(match[1].split(",").map(v => v.trim()));
    }
    for (const name of names) {
      assert.ok(imports[name], "missing imported group " + name);
      for (const fn of imports[name]) {
        assert.ok(declared[name].has(fn), "imported but unexported: " + name + "." + fn);
      }
    }
    for (const match of fixture.matchAll(/\b(?:websocket|quic|compute)_[a-z0-9_]+\s*\(/g)) {
      const fn = match[0].split("(")[0].trim();
      const name = names.find(n => fn.startsWith(n + "_"));
      assert.ok(declared[name].has(fn), "undefined guest callee " + fn);
      assert.ok(imports[name].has(fn), "callee not imported " + fn);
    }
  }
  // Guest-qualified callsites are checked against the public module exports.
  for (const match of fixture.matchAll(/\b(websocket|quic|compute)\.([a-z_][a-z0-9_]*)\s*\(/g)) {
    assert.ok(declared[match[1]].has(match[2]), "undefined qualified guest callee " + match[0]);
  }
  const codes = [...fixture.matchAll(/\bthen return ([0-9]+); fi/g)].map(m => Number(m[1]));
  assert.deepEqual(codes, Array.from({length:37}, (_,i) => i + 1), "37 sequential guest cases required");
  assert.match(fixture, /\breturn 0;\s*\}\s*$/, "guest success return absent");
  assert.doesNotMatch(fixture, /\bquic_varint_min_width\s*\(/,
    "guest references obsolete unbound QUIC helper");
}

test("source exports and every guest call resolve; all 37 guest cases accounted for", () => {
  verify(sources, guest);
});
test("unexported helper or unlinked callee is detected (mutation)", () => {
  const modified = {...sources,
    quic: sources.quic.replace("pub fnc quic_encoding_min_width", "fnc quic_encoding_min_width")};
  assert.throws(() => verify(modified, guest));
  assert.throws(() => verify(sources, guest.replace(
    /quic(?:\.)?quic_encoding_min_width|quic_encoding_min_width/,
    "quic_bogus_min_width")));
});
test("duplicate numbered cases and missing imports cannot pass (mutation)", () => {
  assert.throws(() => verify(sources, guest.replace("then return 37; fi", "then return 36; fi")));
  assert.throws(() => verify(sources, guest.replace(/^import module compute.*\n/m, "")
    .replace(/import fnc compute_exact_buffer_layout,[\s\S]*? from '\.\.\/\.\.\/stdlib\/std\/compute';\n/, "")));
});
const boundary = readFileSync(resolve(root, "tests/stdlib/protocol_boundaries.atto"), "utf8");

function verifyBoundary(source, fixture) {
  const exported = Object.fromEntries(names.map(name => [name,
    new Set([...source[name].matchAll(/\bpub\s+fnc\s+([a-z][a-z0-9_]*)\s*\(/g)].map(m => m[1]))]));
  assert.equal(names.reduce((n, name) => n + exported[name].size, 0), 42,
    "native backend must export exactly 42 public helpers");
  const groups = [...fixture.matchAll(
    /import fnc ([\s\S]*?) from '\.\.\/\.\.\/stdlib\/std\/([a-z]+)';/g
  )];
  assert.equal(groups.length, names.length, "three explicit Atto file imports required");
  const imported = {};
  for (const [, list, name] of groups) {
    assert.ok(names.includes(name), "unexpected import namespace: " + name);
    assert.equal(imported[name], undefined, "duplicate module import: " + name);
    const symbols = list.split(",").map(s => s.trim());
    assert.equal(new Set(symbols).size, symbols.length, "duplicate imported function");
    imported[name] = new Set(symbols);
    assert.equal(imported[name].size, exported[name].size,
      "all public helpers must appear in each backend's native import");
    for (const symbol of symbols) {
      assert.ok(exported[name].has(symbol), "import not exported: " + symbol);
    }
  }
  for (const name of names) assert.ok(imported[name], "missing import: " + name);
  const called = new Set();
  for (const m of fixture.matchAll(/(?<![\w.])((?:websocket|quic|compute)_[a-z0-9_]+)\s*\(/g)) {
    const functionName = m[1], name = names.find(n => functionName.startsWith(n + "_"));
    assert.ok(exported[name].has(functionName), "unknown guest call: " + functionName);
    assert.ok(imported[name].has(functionName), "callee not imported: " + functionName);
    called.add(functionName);
  }
  for (const name of names) {
    for (const symbol of exported[name]) {
      assert.ok(called.has(symbol), "export not tested in Atto boundary guest: " + symbol);
    }
  }
  assert.equal(called.size, 42, "all 42 helpers must be called in the 109 cases");
  const cases = [...fixture.matchAll(/\bthen return (\d+); fi/g)].map(m => Number(m[1]));
  assert.deepEqual(cases, Array.from({length: 109}, (_, i) => i + 1),
    "109 ordered, independently fail-diagnostic Atto cases required");
  assert.match(fixture, /\breturn 0;\s*\}\s*$/, "guest must return zero only after all 109 cases");
  assert.doesNotMatch(fixture, /\bquic_varint_min_width\s*\(/, "obsolete API");
}

test("109-case Atto boundary guest imports and exercises all 42 functions", () => {
  verifyBoundary(sources, boundary);
});
test("boundary source audit rejects five deliberate incomplete or corrupted variants", () => {
  assert.throws(() => verifyBoundary(sources,
    boundary.replace("quic_stream_id_valid(", "quic_missing_stream_id(")));
  assert.throws(() => verifyBoundary(sources,
    boundary.replace("from '../../stdlib/std/compute';",
      "from '../../stdlib/std/missing';")));
  assert.throws(() => verifyBoundary(sources,
    boundary.replace("then return 109; fi", "then return 108; fi")));
  assert.throws(() => verifyBoundary(sources,
    boundary.replace("quic_stream_id_valid,", "")));
  assert.throws(() => verifyBoundary({...sources,
    quic: sources.quic.replace("pub fnc quic_stream_id_valid", "fnc quic_stream_id_valid")
  }, boundary));
});


test("source audit rejects a removed Atto remainder operator on any backend", () => {
  const original = "n - (n / 2) * 2";
  assert.ok(sources.compute.includes(original), "must mutate the actual owned Atto expression");
  const corrupted = {...sources, compute: sources.compute.replace(original, "n % 2")};
  assert.notEqual(corrupted.compute, sources.compute, "negative mutation must alter source");
  assert.throws(() => verify(corrupted, guest),
    "removed % cannot enter the .atto library through a static-only proof");
});

test("bounded nonnegative i64 quotient/subtract identity matches remainder arithmetic", () => {
  const max = (1n << 63n) - 1n;
  const divisors = [1n, 2n, 4n, 8n, 16n, 255n, 256n, 65535n,
    (1n << 62n), max];
  const values = [0n, 1n, 2n, 3n, 7n, 8n, 63n, 64n, 125n, 126n,
    255n, 256n, 15293n, 16384n, (1n << 62n)-1n, (1n << 62n), max-1n, max];
  let state = 0x123456789abcdefn;
  for (let i = 0; i < 2048; i++) {
    state = (state * 6364136223846793005n + 1442695040888963407n) & max;
    values.push(state);
  }
  for (const value of values) for (const divisor of divisors) {
    const product = (value / divisor) * divisor;
    assert.ok(product >= 0n && product <= value && product <= max,
      "intermediate product must fit signed i64 and never exceed input");
    assert.equal(value - product, value % divisor,
      "backend-owned quotient/subtract expression changed remainder semantics");
  }
});


function verifyPaddedComputeDispatch(source, fixture, moduleQualified) {
  const begin = source.indexOf("pub fnc compute_dispatch_valid(");
  const end = source.indexOf("pub fnc compute_simd_lanes_supported(", begin);
  assert.ok(begin >= 0 && end > begin, "missing real Atto dispatch implementation");
  const implementation = source.slice(begin, end);
  assert.match(implementation, /global_x <= 0 \|\| global_y <= 0 \|\| global_z <= 0/,
    "zero-sized logical workloads must be rejected");
  assert.match(implementation, /compute_workgroup_valid\(/,
    "workgroup/device-invocation bound must be enforced");
  assert.doesNotMatch(implementation,
    /\blocal_[xyz]\s*>\s*global_[xyz]\b/,
    "a partial GPU workgroup is not a malformed dispatch");
  assert.match(implementation, /MUST be bounds-guarded/,
    "numerical admission must not claim unchecked GPU memory access");
  const symbol = moduleQualified ? "compute.compute_dispatch_valid" : "compute_dispatch_valid";
  for (const args of [
    "16, 16, 1, 8, 8, 1, 64",
    "1, 1, 1, 8, 8, 1, 64",
    "9, 9, 1, 8, 8, 1, 64",
  ]) assert.ok(fixture.includes(symbol + "(" + args + ")"),
    "missing native .atto partial-workgroup boundary call " + args);
  assert.ok(fixture.includes("return 101; fi"), "lost guest failure status 101");
}

test("compute guest tests admit partial workgroups but preserve kernel bounds contract", () => {
  verifyPaddedComputeDispatch(sources.compute, boundary,
    boundary.includes('import module compute from "+stdlib/std/compute.atto";'));
});
test("source gate rejects regressed partial-workgroup check and missing boundary vector", () => {
  const isQualified=boundary.includes('import module compute from "+stdlib/std/compute.atto";');
  const badSource=sources.compute.replace(
    "  // Local workgroups may extend past the logical global size.",
    "  if local_x > global_x || local_y > global_y || local_z > global_z then return false; fi\n  // Local workgroups may extend past the logical global size.");
  assert.notEqual(badSource,sources.compute);
  assert.throws(() => verifyPaddedComputeDispatch(badSource,boundary,isQualified));
  const name=isQualified ? "compute.compute_dispatch_valid" : "compute_dispatch_valid";
  const badGuest=boundary.replace(name+"(1, 1, 1, 8, 8, 1, 64)",
    name+"(1, 1, 1, 1, 1, 1, 64)");
  assert.notEqual(badGuest,boundary);
  assert.throws(() => verifyPaddedComputeDispatch(sources.compute,badGuest,isQualified));
});
