// Shared Atto proxy ACK v1 host-only state gate; NOT a production wire ABI,
// authentication verifier, socket bridge, or compiled .atto guest support.
// apply_verified() MUST only receive a destination-authorized receipt already
// verified by the runtime's private authenticated sidecar.
const fields = Object.freeze(['tenant', 'caller_incarnation', 'target_actor',
  'target_incarnation', 'placement_epoch', 'message_id', 'attempt']);
const stages = Object.freeze({dispatched: 0, admitted: 1, started: 2, processed: 3});
const outcomes = Object.freeze(['pending', 'rejected', 'failed', 'indeterminate']);
function checked_identity(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      !Object.hasOwn(value, 'protocol_major') || value.protocol_major !== 1)
    throw Error('E_PROXY_IDENTITY');
  const copy = {protocol_major: 1};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'bigint' || descriptor.value <= 0n ||
        descriptor.value > 18446744073709551615n)
      throw Error('E_PROXY_IDENTITY');
    copy[field] = descriptor.value;
  }
  return Object.freeze(copy);
}
export class ProxyReceiptGateV1 {
  #id;
  #stage = 'dispatched';
  #outcome = 'pending';
  #durableInbox = false;
  #durableResult = false;
  constructor(identity) { this.#id = checked_identity(identity); }
  get stage() { return this.#stage; }
  get outcome() { return this.#outcome; }
  get durable_inbox() { return this.#durableInbox; }
  get durable_result() { return this.#durableResult; }
  get destination_admitted() { return stages[this.#stage] >= stages.admitted; }
  apply_verified(identity, event) {
    // An untrusted deserializer must NEVER get access to this method. In
    // particular, it does not verify HMAC/TLS, tenant ACLs or provider commits.
    let observed;
    try { observed = checked_identity(identity); } catch { return false; }
    if (this.#outcome !== 'pending' ||
        fields.some(field => observed[field] !== this.#id[field]))
      return false;
    switch (event) {
      case 'admitted':
        if (stages[this.#stage] < stages.admitted) this.#stage = 'admitted';
        return true;
      case 'started':
        if (stages[this.#stage] < stages.admitted) return false;
        if (stages[this.#stage] < stages.started) this.#stage = 'started';
        return true;
      case 'processed':
        if (stages[this.#stage] < stages.started) return false;
        this.#stage = 'processed';
        return true;
      case 'durable_inbox':
        if (stages[this.#stage] < stages.admitted) return false;
        this.#durableInbox = true;
        return true;
      case 'durable_result':
        if (this.#stage !== 'processed') return false;
        this.#durableResult = true;
        return true;
      case 'rejected':
        if (this.#stage !== 'dispatched') return false;
        this.#outcome = 'rejected';
        return true;
      case 'failed':
        if (this.#stage === 'dispatched' || this.#stage === 'processed') return false;
        this.#outcome = 'failed';
        return true;
      case 'indeterminate':
        if (this.#stage === 'processed') return false;
        this.#outcome = 'indeterminate';
        return true;
      default: return false;
    }
  }
}
export {checked_identity as checked_proxy_receipt_identity_v1};
