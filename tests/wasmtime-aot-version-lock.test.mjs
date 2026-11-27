// Lockfile-only regression checks run under the repository's existing Node 22+ test suite.
// These are static safeguards; cargo --locked tests and actual AOT guest execution remain
// mandatory before this security update can be called validated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Resolve relative to the module URL, without constructing platform-specific
// file:// strings (this test also runs on Windows CI).
const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const pin = '49.0.5';
const craneliftPin = '0.136.5';
const inputs = [
  { name: 'precompile', features: ['std', 'runtime', 'cranelift'] },
  { name: 'run', features: ['std', 'runtime'] },
];

function packages(lockfile) {
  const found = new Map();
  for (const stanza of lockfile.split(/^\[\[package\]\]\s*$/m)) {
    const name = /^name = "([^"]+)"$/m.exec(stanza)?.[1];
    if (!name) continue;
    const version = /^version = "([^"]+)"$/m.exec(stanza)?.[1];
    const checksum = /^checksum = "([^"]+)"$/m.exec(stanza)?.[1];
    // Cargo.lock can legitimately contain multiple versions of unrelated crates
    // (e.g. syn or embedded-io). Security-sensitive runtime/compiler packages
    // must remain unique so a stale second version cannot hide behind Map keys.
    if (found.has(name)) {
      assert.ok(!/^(?:wasmtime(?:-|$)|pulley-|cranelift-)/.test(name),
        `duplicate pinned AOT dependency: ${name}`);
      continue;
    }
    found.set(name, { version, checksum });
  }
  return found;
}

function checkVersions(entries, label) {
  for (const [name, pkg] of entries) {
    const expected = name === 'wasmtime' || name.startsWith('wasmtime-') ||
      name.startsWith('pulley-') ? pin :
      name.startsWith('cranelift-') ? craneliftPin : null;
    if (expected === null) continue;
    assert.equal(pkg.version, expected, `${label}: ${name} has stale/mixed patch version`);
    assert.match(pkg.checksum ?? '', /^[0-9a-f]{64}$/, `${label}: ${name} missing registry checksum`);
  }
  assert.ok(entries.has('wasmtime'), `${label}: Wasmtime dependency missing`);
}

for (const { name, features } of inputs) {
  test(`AOT ${name} pins the patched runtime and a coherent Cargo.lock`, () => {
    const manifest = read(`aot-host/${name}/Cargo.toml`);
    const lockfile = read(`aot-host/${name}/Cargo.lock`);
    assert.match(manifest, new RegExp('wasmtime\\s*=\\s*\\{version\\s*=\\s*"=' + pin.replaceAll('.', '\\.') + '"'));
    assert.match(manifest, /default-features\s*=\s*false/);
    assert.match(manifest, new RegExp('features\\s*=\\s*\\[' + features.map(x => '"'+x+'"').join(',') + '\\]'));
    const locked = packages(lockfile);
    checkVersions(locked, name);
    assert.ok(!lockfile.includes('version = "49.0.3"'), 'old Wasmtime version remains');
    assert.ok(!lockfile.includes('version = "0.136.3"'), 'old Cranelift version remains');
  });
}

test('the standalone AOT runner lock excludes machine-code compilers', () => {
  const locked = packages(read('aot-host/run/Cargo.lock'));
  for (const name of [
    'cranelift-codegen',
    'cranelift-frontend',
    'wasmtime-internal-cranelift',
    'wasmtime-internal-winch',
  ]) {
    assert.ok(!locked.has(name), `runtime-only Cargo.lock contains compiler: ${name}`);
  }
  assert.ok(packages(read('aot-host/precompile/Cargo.lock')).has('wasmtime-internal-cranelift'));
});

test('the version-admission check fails closed for stale or mismatched patches', () => {
  const valid = packages(read('aot-host/run/Cargo.lock'));
  for (const [name, staleVersion] of [['wasmtime', '49.0.3'], ['cranelift-entity', '0.136.3']]) {
    const modified = new Map(valid);
    modified.set(name, { ...modified.get(name), version: staleVersion });
    assert.throws(() => checkVersions(modified, 'negative fixture'), /stale\/mixed patch version/);
  }
});
