import assert from 'node:assert/strict';

// Host telemetry is evidence only when the complete bounded trace agrees
// with the fixture's independently specified container/mode sequence.
export function assertStateTrace(result, {claims, containers, terminal, outstanding = 0}) {
  assert.ok(Array.isArray(result.events) && result.events.length < 4096,
    'state trace missing or potentially truncated');
  assert.ok(result.state?.quiescent === true && result.state.retired === true && result.state.active === 0,
    'state execution not terminal and quiescent');
  assert.equal(result.state.containers, containers);
  assert.equal(result.ok, terminal === 'complete');
  const registered = new Map();
  const entered = [];
  let live = 0, ended = false;
  for (const e of result.events) {
    assert.equal(ended, false, 'event after terminal transition');
    if (e.kind === 'register') {
      assert.ok(Number.isSafeInteger(e.containerId) && e.containerId > 0 && !registered.has(e.containerId), 'duplicate or invalid container');
      registered.set(e.containerId, {ordinal: registered.size + 1, reads: 0, write: false, retired: false});
      continue;
    }
    if (e.kind === 'complete' || e.kind === 'abort') {
      assert.equal(e.kind, terminal);
      assert.equal(live, outstanding, 'unexpected outstanding claims at terminal transition');
      if (e.kind === 'complete') assert.equal(live, 0);
      ended = true;
      continue;
    }
    const c = registered.get(e.containerId);
    assert.ok(c, 'event for unknown container');
    if (e.kind === 'retire') {
      assert.equal(c.retired, false, 'duplicate retirement');
      c.retired = true;
      continue;
    }
    assert.ok(e.mode === 0 || e.mode === 1, 'invalid claim mode');
    if (e.kind === 'enter') {
      assert.ok(!c.retired && !c.write && (e.mode === 0 || c.reads === 0), 'incompatible or retired claim');
      if (e.mode === 0) c.reads++; else c.write = true;
      entered.push([c.ordinal, e.mode]);
      live++;
    } else if (e.kind === 'leave') {
      if (e.mode === 0) { assert.ok(c.reads > 0, 'unmatched reader release'); c.reads--; }
      else { assert.equal(c.write, true, 'unmatched writer release'); c.write = false; }
      live--;
    } else assert.fail('unknown state event: ' + e.kind);
  }
  assert.equal(ended, true, 'missing terminal event');
  assert.equal(registered.size, containers);
  assert.deepEqual(entered, claims, 'fixture claim order, identity or mode mismatch');
}
