// Explicit real-guest execution adapter. NOT called from source-only CI.
// Usage: node scripts/verify-std-metrics-json-zorde-guest.mjs /abs/trusted-guest-runner <binary-sha256>
// The runner must genuinely compile+execute the .atto source argument.
// A stdout match is only CANDIDATE evidence until external authenticated
// compiler provenance and workflow/job/artifact identity are verified.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [runner, pinnedHash] = process.argv.slice(2);
function die(reason, code=1) {
  console.error('ATTO_STDLIB_GUEST=NOT_VERIFIED: ' + reason);
  process.exit(code);
}
if (!runner || !path.isAbsolute(runner) || !/^[0-9a-f]{64}$/.test(pinnedHash ?? '')) {
  die('explicit absolute trusted runner path and SHA256 are required', 2);
}
const sha256 = data => createHash('sha256').update(data).digest('hex');
let bin;
try { bin = readFileSync(runner); } catch { die('runner not readable'); }
if (sha256(bin) !== pinnedHash) die('runner digest mismatch');

const manifest = JSON.parse(readFileSync(
  path.join(root, 'tests/fixtures/std-metrics-json-zorde/expected-stdout.json'), 'utf8'
));
if (manifest.schema !== 'atto.stdlib.metrics-json-zorde.guest-stdout-v1') die('wrong manifest');
if (manifest.status !== 'REFERENCE_NOT_EXECUTED_ON_THIS_BACKEND') die('invalid reference status');
let checked = 0;
for (const name of ['metrics','json','zorde']) {
  const vector = manifest.fixtures?.[name];
  if (!vector || vector.path !== 'tests/fixtures/std-metrics-json-zorde/' + name + '.atto') {
    die('unapproved guest fixture path');
  }
  const sourcePath = path.join(root,vector.path);
  const source = readFileSync(sourcePath);
  const gitBlob = createHash('sha1')
    .update(Buffer.from('blob '+source.length+'\0'))
    .update(source).digest('hex');
  if (gitBlob !== vector.git_blob_sha) die('fixture changed: ' + name);
  const result = spawnSync(runner,[sourcePath],{
    shell:false, cwd:root, encoding:'utf8', timeout:45000, maxBuffer:1024*1024
  });
  if (result.error || result.signal || result.status !== 0) {
    die('runner failed or timed out for '+name+': '+String(result.error || result.stderr).slice(0,300));
  }
  const output = result.stdout.replace(/\r\n/g,'\n').trimEnd();
  const actual = output.length ? output.split('\n') : [];
  const expected = vector.stdout_lines;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const at = expected.findIndex((line,i)=>actual[i]!==line);
    die(name+' guest stdout mismatch at index '+at+
      ' (actual '+JSON.stringify(actual[at])+', expected '+JSON.stringify(expected[at])+')');
  }
  checked += expected.length;
}
if (checked !== 127) die('missing expected guest lines');
console.log('ATTO_STDLIB_CANDIDATE_GUEST_STDOUT_MATCH=127');
console.log('ATTO_STDLIB_PARITY=NOT_VERIFIED_EXTERNAL_PROVENANCE_REQUIRED');
