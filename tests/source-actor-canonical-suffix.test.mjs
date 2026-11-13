import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, writeFile, chmod, readFile, rm, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {compileSourceActorToWasm} from '../scripts/compile-source-actor.mjs';

// Adapter-only negative tests. The fake executable deliberately emits NO IR:
// these tests certify source suffix and snapshot staging, never guest parity.
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('real actor compiler adapter preserves canonical .atto and legacy .ores source suffixes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atto-actor-suffix-'));
  try {
    const compiler = join(dir, 'fake-compiler');
    const fake = [
      '#!/usr/bin/env node',
      "const {extname, basename} = require('node:path');",
      "const {readFileSync} = require('node:fs');",
      "const file = process.argv.at(-1);",
      "if (basename(file) !== 'source' + extname(file)) process.exit(31);",
      "if (readFileSync(file, 'utf8') !== 'pub fnc main(): int { return 42; }\\n') process.exit(32);",
      "process.stderr.write('FAKE_STAGED_SUFFIX=' + extname(file));",
      'process.exit(29);',
      ''
    ].join('\n');
    await writeFile(compiler, fake, {mode: 0o700});
    await chmod(compiler, 0o700);
    const pin = sha256(Buffer.from(fake));
    for (const ext of ['.atto', '.ores']) {
      const source = join(dir, 'counter' + ext);
      const original = 'pub fnc main(): int { return 42; }\n';
      await writeFile(source, original);
      await assert.rejects(
        compileSourceActorToWasm({compiler, source, expectedCompilerSha256: pin}),
        new RegExp('FAKE_STAGED_SUFFIX=\\\\' + ext));
      assert.equal(await readFile(source, 'utf8'), original);
    }
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('actor bridge rejects unknown source extension before running a compiler', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atto-actor-reject-extension-'));
  try {
    const touched = join(dir, 'invoked');
    const compiler = join(dir, 'fake-compiler');
    const script = [
      '#!/usr/bin/env node',
      "require('node:fs').writeFileSync(" + JSON.stringify(touched) + ", 'yes');",
      'process.exit(29);',
      ''
    ].join('\n');
    await writeFile(compiler, script, {mode: 0o700});
    await chmod(compiler, 0o700);
    const source = join(dir, 'counter.txt');
    await writeFile(source, 'pub fnc main(): int { return 42; }\n');
    await assert.rejects(
      compileSourceActorToWasm({
        compiler, source, expectedCompilerSha256: sha256(Buffer.from(script))
      }),
      /canonical \\.atto or legacy \\.ores extension/);
    await assert.rejects(stat(touched), /ENOENT/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});
