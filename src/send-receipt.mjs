// atto.browser.send-receipt.v1
// Correlation and observed outcome, never a transferable capability.
// "processed" means a destination handler acknowledged completion.
// "rejected" means no destination delivery was dispatched.
// "unknown" means delivery was dispatched, but processing cannot be proven.
export const RECEIPT_PROTOCOL='atto.browser.send-receipt.v1';
export const RECEIPT_OUTCOMES=Object.freeze(['processed','rejected','unknown']);
export const RECEIPT_CODES=Object.freeze([
  'OK','E_ROUTE_STALE','E_ROUTE_BACKPRESSURE','E_ROUTE_TIMEOUT',
  'E_ROUTE_UNAVAILABLE','E_ROUTE_CRASH','E_ROUTE_REVOKED',
  'E_ROUTE_RECEIVER','E_ROUTE_PROTOCOL','E_ROUTE_UNKNOWN'
]);
const valid_id=n=>Number.isSafeInteger(n) && n>0;
const valid_tenant=s=>typeof s==='string' &&
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(s);
export function assert_send_receipt(value) {
  if(!value || Object.getPrototypeOf(value)!==Object.prototype ||
      value.protocol!==RECEIPT_PROTOCOL ||
      !valid_id(value.receipt_id) || !valid_id(value.route_id) ||
      !valid_tenant(value.source) || !valid_tenant(value.target) ||
      !valid_id(value.source_generation) || !valid_id(value.target_generation) ||
      !Number.isSafeInteger(value.actor_id) || value.actor_id<0 || value.actor_id>64 ||
      !RECEIPT_OUTCOMES.includes(value.outcome) ||
      !RECEIPT_CODES.includes(value.code) ||
      ((value.outcome==='processed')!==(value.code==='OK')))
    throw new Error('E_RECEIPT_PROTOCOL');
  return {
    protocol:RECEIPT_PROTOCOL,receipt_id:value.receipt_id,
    route_id:value.route_id,source:value.source,
    source_generation:value.source_generation,
    target:value.target,target_generation:value.target_generation,
    actor_id:value.actor_id,outcome:value.outcome,code:value.code
  };
}
export function create_send_receipt(route,receipt_id,outcome,code) {
  return assert_send_receipt({protocol:RECEIPT_PROTOCOL,receipt_id,
    route_id:route.id,source:route.source.id,
    source_generation:route.source_generation,
    target:route.target.id,target_generation:route.target_generation,
    actor_id:route.actor_id,outcome,code});
}
export function assert_send_failure(value) {
  if(!value || Object.getPrototypeOf(value)!==Object.prototype ||
      value.protocol!==RECEIPT_PROTOCOL ||
      !['rejected','unknown'].includes(value.outcome) ||
      !RECEIPT_CODES.includes(value.code) || value.code==='OK' ||
      !Array.isArray(value.prior_receipts) || value.prior_receipts.length>16)
    throw new Error('E_RECEIPT_PROTOCOL');
  const prior_receipts=value.prior_receipts.map(assert_send_receipt);
  if(prior_receipts.some(x=>x.outcome!=='processed'))
    throw new Error('E_RECEIPT_PROTOCOL');
  const receipt=value.receipt===null ? null : assert_send_receipt(value.receipt);
  if(receipt && (receipt.outcome!==value.outcome || receipt.code!==value.code))
    throw new Error('E_RECEIPT_PROTOCOL');
  return {protocol:RECEIPT_PROTOCOL,code:value.code,outcome:value.outcome,
    receipt,prior_receipts};
}
export function create_send_failure(code,outcome,receipt=null,prior_receipts=[]) {
  return assert_send_failure({protocol:RECEIPT_PROTOCOL,code,outcome,receipt,prior_receipts});
}
