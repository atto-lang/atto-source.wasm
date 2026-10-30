import test from "node:test";
import assert from "node:assert/strict";

import {
  captureExecutionCallbackContext,
  createExecutionContext,
  currentExecutionCallbackContext,
  isExecutionCallbackContext,
  runWithExecutionCallbackContext,
} from "../src/execution-callback-context.mjs";

function origin(execution = 41n, dispatch = 7n) {
  return createExecutionContext({
    runtimeDomain: 17n,
    execution,
    dispatch,
    generation: 3n,
    parentExecution: 11n,
    continuation: 5n,
  });
}

test("callback provenance is explicit, immutable, and not guest authority", () => {
  const callback = captureExecutionCallbackContext(origin(), "IO");
  assert.equal(isExecutionCallbackContext(callback), true);
  assert.equal(Object.isFrozen(callback), true);
  assert.equal(callback.execution, 41n);
  assert.equal(callback.boundary, "IO");
  assert.equal("memory" in callback, false);
  assert.equal("actor" in callback, false);
  assert.equal("enterGuest" in callback, false);
});

test("nested callback scopes restore LIFO and clear through throws", () => {
  const outer = captureExecutionCallbackContext(origin(41n, 7n), "HOST_CALLBACK");
  const inner = captureExecutionCallbackContext(origin(42n, 8n), "TIMER");
  assert.equal(currentExecutionCallbackContext(), null);

  assert.throws(() => runWithExecutionCallbackContext(outer, () => {
    assert.equal(currentExecutionCallbackContext(), outer);
    runWithExecutionCallbackContext(inner, () => {
      assert.equal(currentExecutionCallbackContext(), inner);
    });
    assert.equal(currentExecutionCallbackContext(), outer);
    throw new Error("boom");
  }), /boom/);

  assert.equal(currentExecutionCallbackContext(), null);
});

test("callback provenance does not flow implicitly into a later microtask", async () => {
  const callback = captureExecutionCallbackContext(origin(), "HOST_CALLBACK");
  let observedInside;
  let observedLater = "unset";

  await new Promise((resolve) => {
    runWithExecutionCallbackContext(callback, () => {
      observedInside = currentExecutionCallbackContext();
      queueMicrotask(() => {
        observedLater = currentExecutionCallbackContext();
        resolve();
      });
    });
  });

  assert.equal(observedInside, callback);
  assert.equal(observedLater, null);
});

test("structured callback provenance survives explicit worker-message style copying", () => {
  const callback = captureExecutionCallbackContext(origin(), "ACTOR_MESSAGE");
  const copied = structuredClone(callback);
  assert.notEqual(copied, callback);
  assert.equal(Object.isFrozen(copied), false);
  assert.equal(isExecutionCallbackContext(copied), true);
  assert.deepEqual(copied, callback);

  let installed;
  runWithExecutionCallbackContext(copied, () => {
    installed = currentExecutionCallbackContext();
    assert.notEqual(installed, copied);
    assert.equal(Object.isFrozen(installed), true);
    assert.deepEqual(installed, callback);
  });
  assert.equal(currentExecutionCallbackContext(), null);

  copied.execution = 999n;
  assert.equal(installed.execution, 41n,
    "installed provenance must not alias mutable worker-message input");
});

test("malformed and producer-ambient inputs fail closed", () => {
  assert.throws(
    () => captureExecutionCallbackContext(null, "IO"),
    /explicit Ores execution context/,
  );
  assert.throws(
    () => captureExecutionCallbackContext(origin(), "NOT_A_BOUNDARY"),
    /invalid Ores callback boundary/,
  );
  assert.throws(
    () => runWithExecutionCallbackContext({ kind: "ores.callback.v1" }, () => {}),
    /callback context contains unexpected fields|invalid Ores callback boundary/,
  );

  const smuggled = {
    ...structuredClone(captureExecutionCallbackContext(origin(), "IO")),
    actor: { enterGuest: true },
  };
  assert.equal(isExecutionCallbackContext(smuggled), false);
  assert.throws(
    () => runWithExecutionCallbackContext(smuggled, () => {}),
    /unexpected fields/,
  );
  assert.equal(currentExecutionCallbackContext(), null);
});
