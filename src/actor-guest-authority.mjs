// Trusted CONTROL-only issuer. A source Oreslang/Wasm actor never imports
// this JS module and receives no references to its host ActorArena.
// Each one-shot permit binds the exact host arena OBJECT identity to a
// pinned SHA-256 artifact, not merely to a user-supplied actor "kind".
// NOTE: Node JS modules within the same realm are NOT a security boundary.
// The issuer must be confined to the trusted host; arbitrary userland JS
// must run in a separate sandbox/process, never in this realm.
const permits = new WeakMap();
const nativeFreeze = Object.freeze;
const mapGet = WeakMap.prototype.get;
const mapSet = WeakMap.prototype.set;

export function issueTrustedActorGuestPermit(actorArena, expectedSha256) {
  if ((typeof actorArena !== "object" || actorArena === null) ||
      typeof expectedSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new TypeError("invalid trusted actor guest permit request");
  }
  const permit = nativeFreeze({});
  mapSet.call(permits, permit, {
    owner: actorArena, sha256: expectedSha256, used: false
  });
  return permit;
}

// Called from ActorArena's private guest-admission path, NOT by the guest.
// Consume before compilation: failed admission never reactivates the token.
export function consumeTrustedActorGuestPermit(actorArena, permit) {
  const record = mapGet.call(permits, permit);
  if (!record || record.owner !== actorArena || record.used)
    throw new Error("foreign, forged or consumed trusted actor guest permit");
  record.used = true;
  return record.sha256;
}
