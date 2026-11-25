// Narrow host->guest env primitive ABI v1 (not a compiler import linker).
// A trusted host passes an already admitted and branded snapshot object.
// Guest-supplied requests may select only get/has and a validated key.
// Never accept permissions, environment values, host functions or globals
// from a guest message; never expose revoke() through this dispatcher.
import {EnvHostError, is_scoped_env_host} from './std-env-host.mjs';

function valid_request(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request))
    return null;
  const prototype = Object.getPrototypeOf(request);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(request);
  if (keys.length !== 2 || !keys.includes('operation') || !keys.includes('name'))
    return null;
  const operation = Object.getOwnPropertyDescriptor(request, 'operation');
  const name = Object.getOwnPropertyDescriptor(request, 'name');
  if (!operation || !name || !Object.hasOwn(operation, 'value') ||
      !Object.hasOwn(name, 'value') ||
      typeof operation.value !== 'string' || typeof name.value !== 'string')
    return null;
  if (operation.value !== 'get' && operation.value !== 'has') return null;
  return [operation.value, name.value];
}

/**
 * Host-only bridge into the two primitive calls expected by std/env.atto.
 * Wire replies do not directly mint Option/Result in guest memory: native
 * compiler lowering must verify and construct those guest values separately.
 * Call with structured-clone/JSON-decoded data, not arbitrary guest Proxy
 * objects from a shared JS isolate.
 */
export function create_env_guest_dispatch_v1(scoped_host) {
  if (!is_scoped_env_host(scoped_host))
    throw new EnvHostError('ENV_INVALID_HOST');
  return Object.freeze({
    dispatch(request) {
      try {
        const admitted = valid_request(request);
        if (!admitted) return Object.freeze({tag: 'error', code: 'ENV_INVALID_REQUEST'});
        const [operation, name] = admitted;
        if (operation === 'has')
          return Object.freeze({tag: 'bool', value: scoped_host.has(name)});
        const found = scoped_host.get(name);
        return found.some
          ? Object.freeze({tag: 'some', value: found.value})
          : Object.freeze({tag: 'none'});
      } catch (failure) {
        // Never serialize host error messages or secret environment values.
        const code = failure instanceof EnvHostError &&
          ['ENV_PERMISSION_DENIED', 'ENV_INVALID_NAME'].includes(failure.message)
          ? failure.message : 'ENV_HOST_FAILURE';
        return Object.freeze({tag: 'error', code});
      }
    }
  });
}
