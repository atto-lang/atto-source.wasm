// Explicit candidate-artifact qualification, not a shipped binary replacement.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createCompiler,verifyCompilerBytes} from '../src/canonical-browser-compiler.mjs';

const [artifact, expectedDigest] = process.argv.slice(2);
assert.ok(artifact && /^[a-f0-9]{64}$/.test(expectedDigest ?? ''), 'artifact path and independently pinned SHA-256 required');
const bytes = await readFile(artifact);
await verifyCompilerBytes(bytes, expectedDigest, bytes.length);
const compiler = await createCompiler(bytes);
const module = new WebAssembly.Module(bytes);
const exports = new Set(WebAssembly.Module.exports(module).map(e=>e.name));
let canonicalDiagnostic;
for (const spelling of ['suspends','susp','⧖','∂']) {
  const rejected = compiler.compile(spelling+' fnc main(): int { return 42; }');
  assert.equal(rejected.ok,false,spelling);
  assert.equal('wasm' in rejected,false);
  assert.equal('esm' in rejected,false);
  const diagnostic = rejected.diagnostics[0];
  assert.match(diagnostic.message,/suspends|unsupported/i,spelling);
  if (canonicalDiagnostic === undefined) canonicalDiagnostic=diagnostic.message;
  else assert.equal(diagnostic.message,canonicalDiagnostic,spelling);
  const control=compiler.compile('pub fnc main(): int { return 42; } // '+spelling);
  assert.equal(control.ok,true,spelling);
  const guest=new WebAssembly.Module(control.wasm);
  assert.deepEqual(WebAssembly.Module.imports(guest),[]);
  const instance=new WebAssembly.Instance(guest,{});
  assert.equal(instance.exports.main(),42n);
}
console.log('SUSPENSION_ALIAS_WASM_CANDIDATE_PASS',createHash('sha256').update(bytes).digest('hex'));
console.log('CANDIDATE_JAVASCRIPT_EMITTER='+exports.has('compile_js'));
// Report the ABI difference, never silently promote an incomplete candidate.
if (!exports.has('compile_js')) console.log('DUAL_TARGET_VENDOR_PROMOTION=BLOCKED');
