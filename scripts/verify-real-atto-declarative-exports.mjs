#!/usr/bin/env node
/**
 * Real AttoLang browser-frontend -> Wasm host declarative-export contract.
 *
 * Requires an independently obtained, exact-SHA pinned native `attoc` binary
 * from atto-lang/atto-source.rs PR #85 (or a reviewed successor). It is not
 * part of source-free npm test: passing without the compiler is forbidden.
 *
 *   ATTOC_PATH=/absolute/path/to/attoc ATTOC_SHA256=<64 hex> \\
 *      node scripts/verify-real-atto-declarative-exports.mjs
 *
 * This verifies genuine compiler-emitted metadata, NOT multi-file linking,
 * host capability provisioning, or package import enforcement.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {isAbsolute, join} from 'node:path';
import {readDeclarativeExports, listPublicDeclarativeExports} from '../src/declarative-exports.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const declarations = `define class Foo as
end
define class Bar as
end
fnc calculate(int n): int { return n + 1; }
pub fnc main(): int { return calculate(41); }
`;
const exportsSource = `export pub Foo;
export pub[pkg] class Bar;
export pub fnc calculate;
`;
const expectedEntries = [
  {name:'Bar', kind:'class', visibility:'package'},
  {name:'Foo', kind:'class', visibility:'public'},
  {name:'calculate', kind:'fnc', visibility:'public'}
];

function verify() {
  const compilerPath = process.env.ATTOC_PATH;
  const compilerSha = process.env.ATTOC_SHA256;
  if (typeof compilerPath !== 'string' || !isAbsolute(compilerPath))
    throw Error('ATTOC_PATH must be an absolute path to the native attoc compiler');
  if (typeof compilerSha !== 'string' || !/^[a-f0-9]{64}$/.test(compilerSha))
    throw Error('ATTOC_SHA256 must be the expected 64-character lowercase digest');

  const stat = statSync(compilerPath);
  if (!stat.isFile() || stat.size < 1 || stat.size > 256 * 1024 * 1024)
    throw Error('attoc compiler is not a bounded regular file');
  const compilerBytes = readFileSync(compilerPath);
  const observedCompilerSha = sha256(compilerBytes);
  if (observedCompilerSha !== compilerSha)
    throw Error('ATTOC_COMPILER_SHA256_MISMATCH');

  const work = mkdtempSync(join(tmpdir(), 'atto-exports-real-'));
  try {
    // Execute the same immutable copied bytes whose SHA-256 was checked.
    // Never validate one executable pathname then run a mutable original.
    const pinnedCompiler = join(work, 'attoc-pinned');
    writeFileSync(pinnedCompiler, compilerBytes, {flag:'wx', mode:0o500});
    chmodSync(pinnedCompiler, 0o500);
    const env = {PATH: process.env.PATH || '/usr/bin:/bin',
      HOME: work, TMPDIR: work, TZ:'UTC', LC_ALL:'C'};

    function compile(id, source, errorCode = null) {
      const input = join(work, id + '.atto');
      const output = join(work, id + '.wasm');
      writeFileSync(input, source, {flag:'wx', mode:0o400});
      const result = spawnSync(pinnedCompiler, [input, '-o', output], {
        cwd: work, env, timeout: 30_000, maxBuffer: 512 * 1024,
        encoding: 'utf8', shell: false
      });
      assert.equal(result.error, undefined, id + ': compiler launch failed');
      assert.equal(result.signal, null, id + ': compiler was killed or timed out');
      assert.equal(result.stdout, '', id + ': unexpected compiler stdout');
      if (errorCode !== null) {
        assert.equal(result.status, 1, id + ': expected diagnosed rejection');
        assert.match(result.stderr, new RegExp('\\b' + errorCode + '\\b'),
          id + ': rejection must originate in the compiler');
        // Native attoc only writes -o output on successful compilation.
        assert.equal(existsSync(output), false, id + ': rejection produced a Wasm artifact');
        return null;
      }
      assert.equal(result.status, 0, id + ': compiler failed: ' + result.stderr);
      assert.equal(result.stderr, '', id + ': unexpected compiler stderr');
      const binary = readFileSync(output);
      assert.ok(binary.length >= 8 && binary.length <= 16 * 1024 * 1024,
        id + ': bounded Wasm artifact required');
      assert.equal(WebAssembly.validate(binary), true, id + ': invalid Wasm output');
      return binary;
    }

    const top = compile('top', exportsSource + declarations);
    const bottom = compile('bottom', declarations + exportsSource);
    assert.ok(top.equals(bottom), 'forward export placement changed binary bytes');
    const module = new WebAssembly.Module(top);
    assert.equal(WebAssembly.Module.customSections(module, 'atto.exports.v1').length, 1);
    assert.deepEqual(readDeclarativeExports(module), expectedEntries);
    assert.deepEqual(listPublicDeclarativeExports(module), expectedEntries.slice(1));
    // Execute the compiler-produced guest, not a source-free metadata mock.
    // The browser subset exports main(): i64. This scalar fixture needs no
    // host imports and must return the real value 42 as a BigInt.
    assert.deepEqual(WebAssembly.Module.imports(module), [],
      'declarative-export fixture unexpectedly requested host imports');
    const instance = new WebAssembly.Instance(module, {});
    assert.equal(instance.exports.main(), 42n, 'compiler-produced guest returned wrong value');
    const wasmExports = WebAssembly.Module.exports(module).map(item => item.name);
    assert.ok(wasmExports.includes('main'), 'actual wasm guest main is missing');
    for (const name of ['Foo', 'Bar', 'calculate'])
      assert.equal(wasmExports.includes(name), false,
        name + ': language export cannot become a raw host Wasm export');

    // The compiler may admit Unicode identifiers in ordinary source, but
    // atto.exports.v1 is a canonical ASCII-only, <=256-byte wire contract.
    const maxName = 'A' + 'z'.repeat(255);
    const maxSource = 'export pub fnc ' + maxName + ';\nfnc ' + maxName +
      '(): int { return 7; }\npub fnc main(): int { return 0; }';
    const maxWasm = compile('name256', maxSource);
    assert.deepEqual(readDeclarativeExports(new WebAssembly.Module(maxWasm)),
      [{name:maxName, kind:'fnc', visibility:'public'}]);

    const oversizedName = 'A' + 'z'.repeat(256);
    for (const visibility of ['pub', 'pub[pkg]']) {
      compile('name257-' + visibility.replace(/[^a-z]/g, ''), 'export ' + visibility +
        ' fnc ' + oversizedName + ';\nfnc ' + oversizedName +
        '(): int { return 7; }\npub fnc main(): int { return 0; }',
      'E_EXPORT_NAME_TOO_LONG');
    }
    compile('name-unicode',
      'export pub fnc Éclair;\nfnc Éclair(): int { return 7; }\n' +
      'pub fnc main(): int { return 0; }', 'E_EXPORT_NAME');

    compile('unbound', 'export pub Missing;\npub fnc main(): int { return 0; }', 'E_UNBOUND');
    compile('duplicate', 'export pub Foo;\nexport pub class Foo;\n' +
      'define class Foo as end\npub fnc main(): int { return 0; }', 'E_DUPLICATE');
    compile('wrong-kind', 'export pub fnc Foo;\n' +
      'define class Foo as end\npub fnc main(): int { return 0; }', 'E_EXPORT_KIND');

    console.log(JSON.stringify({
      result:'REAL_ATTO_EXPORTS_VERIFIED',
      compilerSha256: observedCompilerSha, wasmSha256:sha256(top),
      forwardPlacementIdentical:true, declared:expectedEntries.length,
      negativeRejections:6, maxExportNameBytes:256, guestResult:'42',
      testedSource:'native attoc executable -> executed genuine Wasm module'
    }));
  } finally {
    rmSync(work, {recursive:true, force:true});
  }
}

try {
  verify();
} catch (error) {
  console.error('REAL_ATTO_EXPORTS_REJECTED: ' + (error?.stack || String(error)));
  process.exitCode = 1;
}
