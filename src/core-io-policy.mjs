import {types as nodeTypes} from "node:util";

// A language invariant, never an option or a host-granted capability.
export const CORE_IO_POLICY = "native-async-only";

// Reject attempts to select a compatibility policy instead of silently ignoring
// unknown fields in the public embedding APIs. Inspect before destructuring so
// option getters cannot execute ambient I/O during guest admission.
export function assertGuestOptions(options, allowed) {
  if (nodeTypes.isProxy(options) || !options || typeof options !== "object" || Array.isArray(options) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(options))) {
    throw new TypeError("guest options must be plain data");
  }
  for (const key of Reflect.ownKeys(options)) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (typeof key !== "string" || !allowed.includes(key) ||
        !descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError("unsupported guest option; native-async-only I/O cannot be changed");
    }
  }
}
