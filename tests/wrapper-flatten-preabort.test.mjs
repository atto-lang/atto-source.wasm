import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

// Isolate strict unhandled-rejection handling from node:test itself.
for (const settlement of ['immediate', 'late']) {
  test(`pre-aborted observer drains ${settlement} producer rejection`, () => {
    const moduleUrl = new URL('../src/wrapper-flatten-host.mjs', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import {flattenFuture} from ${JSON.stringify(moduleUrl)};
      const controller = new AbortController();
      const reason = new Error('observer cancelled');
      controller.abort(reason);
      const failure = new Error('producer failed');
      const producer = ${settlement === 'immediate' ? 'Promise.reject(failure)' : 'new Promise((_, reject) => setImmediate(() => reject(failure)))'};
      await assert.rejects(flattenFuture(producer, {signal: controller.signal}), e => e === reason);
      await new Promise(resolve => setTimeout(resolve, 20));
      // Observation must not replace the original producer failure.
      await assert.rejects(producer, e => e === failure);
    `], {encoding: 'utf8', timeout: 5000});
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  });
}
