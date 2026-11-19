/**
 * Universal Hot Load (UHL-1) broker-facing capability discovery.
 *
 * CURRENT CAPABILITIES: NONE. The core Wasm bridge can atomically publish
 * immutable artifacts, but it cannot yet suspend live Oreslang source actors,
 * migrate heap/ETS state or publish supervised routes. Never conflate an
 * installed .wasm module with a live actor-generation transition.
 *
 * No WebAssembly guest import is introduced by this module. It is exclusively
 * a trusted-host/broker inspection interface.
 */
export const UHL1_ABI_VERSION = 1;
export const UHL1_INTERFACE = 'ores.hotload/v1';

const unsupported = Object.freeze({
  codeOnly: false,
  stateMigration: false,
  supervisedSubtree: false,
  etsHeir: false,
  etsSchemaMigration: false,
  untrustedReplacement: false,
  nativeImageUnload: false,
});
const transitions = Object.freeze({
  aotToAot: false,
  aotToJit: false,
  jitToAot: false,
  jitToJit: false,
});
const caps = Object.freeze({
  interface: UHL1_INTERFACE,
  abiVersion: UHL1_ABI_VERSION,
  backend: 'wasm',
  featureSupport: unsupported,
  executionModes: transitions,
  maxManifestBytes: 0,
  maxCheckpointBytes: 0,
  maxLiveGenerations: 0,
  supervisorAuthorityExposedToGuest: false,
  adapterKind: 'trusted-broker-only',
});

export class UnsupportedHotUpgradeError extends Error {
  constructor() {
    super('UHL-1 live actor/ETS hot upgrade is unsupported by this Wasm host');
    this.name = 'UnsupportedHotUpgradeError';
    this.code = 'ORES_HOT_UNSUPPORTED';
  }
}

/** A rejected version cannot silently reuse a newer or older table layout. */
export function queryHotLoadCapabilities(requestedVersion = UHL1_ABI_VERSION) {
  if (requestedVersion !== UHL1_ABI_VERSION)
    throw new RangeError('unsupported UHL-1 ABI version');
  return caps;
}

/** No manifest, pointer, executable bytes or guest data may be dereferenced. */
export function stageHotUpgrade(_candidate) {
  throw new UnsupportedHotUpgradeError();
}

/** Disallow guest-driven, stale and forged commit attempts alike. */
export function commitHotUpgrade(_transaction, _expectedRouteEpoch) {
  throw new UnsupportedHotUpgradeError();
}

/** No table-heir transfer without a runtime-owned ETS provider. */
export function acknowledgeEtsHeir(_receipt, _heir) {
  throw new UnsupportedHotUpgradeError();
}
