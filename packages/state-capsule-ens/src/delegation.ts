/**
 * delegation.ts — Single-use ENS delegation subnames.
 *
 * When an agent hands off to the next role, it issues a delegation subname:
 *   handoff-<8-char capsule_id>.<parent>
 *   e.g. handoff-a1b2c3d4.maintainerswarm.eth
 *
 * Text records carried:
 *   delegation.capsule_ref  — capsule_id being handed off
 *   delegation.from_role    — sender agent role
 *   delegation.to_role      — receiver agent role
 *   delegation.expiry       — ISO 8601 timestamp
 *
 * The receiving agent calls verifyDelegation to confirm the subname exists
 * and the handoff is not expired. Once consumed, the sender calls
 * revokeDelegation to burn the subname (revocation = burn).
 *
 * All methods log a warning on failure — ENS is never on the critical path.
 */

import type { NameStoneRegistrar } from "./registrar.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DelegationRecords {
  "delegation.capsule_ref": string;
  "delegation.from_role":   string;
  "delegation.to_role":     string;
  "delegation.expiry":      string;
}

export interface VerifiedDelegation extends DelegationRecords {
  label:     string;
  full_name: string;
  valid:     boolean;  // false if expired or not found
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function delegationLabel(capsuleId: string): string {
  const slug = capsuleId.replace(/^0x/, "").slice(0, 8);
  return `handoff-${slug}`;
}

function defaultExpiry(ttlSeconds = 3600): string {
  return new Date(Date.now() + ttlSeconds * 1000).toISOString();
}

// ── DelegationManager ─────────────────────────────────────────────────────────

export class DelegationManager {
  constructor(private registrar: NameStoneRegistrar) {}

  /**
   * Issue a delegation subname for a handoff.
   * Returns the delegation label (not the full name).
   */
  async issueDelegation(
    capsuleRef: string,
    fromRole:   string,
    toRole:     string,
    ttlSeconds  = 3600,
  ): Promise<string> {
    const label = delegationLabel(capsuleRef);
    await this.registrar.issueSubname(label, {
      "delegation.capsule_ref": capsuleRef,
      "delegation.from_role":   fromRole,
      "delegation.to_role":     toRole,
      "delegation.expiry":      defaultExpiry(ttlSeconds),
    });
    return label;
  }

  /**
   * Verify a delegation subname.
   * Returns null if the subname does not exist.
   * Sets `valid = false` if the delegation has expired.
   */
  async verifyDelegation(capsuleRef: string): Promise<VerifiedDelegation | null> {
    const label   = delegationLabel(capsuleRef);
    const records = await this.registrar.resolveSubname(label);
    if (!records) return null;

    const expiry = records["delegation.expiry"] ?? "";
    const valid  = expiry ? new Date(expiry) > new Date() : false;

    const domain    = (this.registrar as unknown as { cfg: { domain: string } }).cfg?.domain ?? "";
    const full_name = domain ? `${label}.${domain}` : label;

    return {
      label,
      full_name,
      "delegation.capsule_ref": records["delegation.capsule_ref"] ?? capsuleRef,
      "delegation.from_role":   records["delegation.from_role"]   ?? "",
      "delegation.to_role":     records["delegation.to_role"]     ?? "",
      "delegation.expiry":      expiry,
      valid,
    };
  }

  /**
   * Revoke a delegation subname (burn). Called by the handoff sender after
   * the receiver has consumed the delegation.
   */
  async revokeDelegation(capsuleRef: string): Promise<void> {
    await this.registrar.burnSubname(delegationLabel(capsuleRef));
  }
}

// ── Graceful wrapper ──────────────────────────────────────────────────────────

/**
 * Build a delegation issuer that never throws.
 * Returns a label if successful, undefined on any error.
 */
export function buildDelegationIssuer(
  registrar: NameStoneRegistrar | null,
): ((capsuleRef: string, fromRole: string, toRole: string) => Promise<string | undefined>) {
  if (!registrar) return async () => undefined;

  const mgr = new DelegationManager(registrar);

  return async (capsuleRef, fromRole, toRole) => {
    try {
      const label = await mgr.issueDelegation(capsuleRef, fromRole, toRole);
      console.log(`[ens] delegation issued: ${label} (${fromRole} → ${toRole})`);
      return label;
    } catch (err) {
      console.warn(`[ens] delegation issuance failed (non-fatal): ${err}`);
      return undefined;
    }
  };
}

/**
 * Build a delegation revoker that never throws.
 */
export function buildDelegationRevoker(
  registrar: NameStoneRegistrar | null,
): ((capsuleRef: string) => Promise<void>) {
  if (!registrar) return async () => {};

  const mgr = new DelegationManager(registrar);

  return async (capsuleRef) => {
    try {
      await mgr.revokeDelegation(capsuleRef);
    } catch (err) {
      console.warn(`[ens] delegation revocation failed (non-fatal): ${err}`);
    }
  };
}
