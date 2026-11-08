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
  const exitCode = await worker.terminate();
  onConfirmed();
  return exitCode;
}
