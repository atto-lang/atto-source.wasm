/** 
 * Trusted Node worker termination confirmation gate.
 *
 * The caller must retain its worker-admission credit until this promise
 * resolves. A thrown/rejected termination MUST NOT invoke onConfirmed,
 * even when the caller is concurrently settling an error or timeout.
 */
export async function confirmWorkerTermination(worker, onConfirmed) {
  if (!worker || typeof worker.terminate !== 'function' ||
      typeof onConfirmed !== 'function')
    throw new TypeError('invalid trusted worker termination boundary');
  // Node Worker.terminate() has a Promise completion receipt. Do not
  // interpret a void return from a stub/regressed adapter as confirmation.
  const termination = worker.terminate();
  if (termination === null || termination === undefined ||
      typeof termination.then !== 'function')
    throw new TypeError('missing async worker termination confirmation');
  const exitCode = await termination;
  onConfirmed();
  return exitCode;
}
