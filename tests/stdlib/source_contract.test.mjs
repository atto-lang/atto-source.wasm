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
