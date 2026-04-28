/**
 * sign.ts — ed25519 sign + verify for capsule payloads.
 *
 * Signing input is the JSON Canonicalization Scheme (JCS / RFC 8785)
 * serialization of the capsule payload minus the `signature` field.
 * This makes signatures deterministic across implementations regardless
 * of JSON key ordering.
 */

import { ed25519 } from "@noble/curves/ed25519";
import { createRequire } from "node:module";
import type { PreIdPayload, SignablePayload } from "./schema.js";

// canonicalize is a CJS-only module; load via createRequire to stay ESM-safe
const _require = createRequire(import.meta.url);
const _canonicalize = _require("canonicalize") as (
  value: Record<string, unknown>
) => string;

// ── Key generation ────────────────────────────────────────────────────────────

export interface KeyPair {
  privateKey: Uint8Array;   // 32-byte ed25519 private key
  publicKey:  Uint8Array;   // 32-byte ed25519 public key
}

export function generateKeyPair(): KeyPair {
  const privateKey = ed25519.utils.randomPrivateKey();
  const publicKey  = ed25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

export function publicKeyFromPrivate(privateKey: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(privateKey);
}

// ── Hex helpers ───────────────────────────────────────────────────────────────

export function toHex(bytes: Uint8Array): string {
  return "0x" + Buffer.from(bytes).toString("hex");
}

export function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex.replace(/^0x/, ""), "hex"));
}

// ── Canonical serialization ───────────────────────────────────────────────────

export function canonicalBytes(payload: Record<string, unknown>): Uint8Array {
  const json = _canonicalize(payload);
  if (json === undefined) throw new Error("canonicalize returned undefined");
  return new TextEncoder().encode(json);
}

// ── Sign ─────────────────────────────────────────────────────────────────────

export function signCapsule(
  payload: SignablePayload,
  privateKey: Uint8Array
): string {
  const bytes = canonicalBytes(payload as unknown as Record<string, unknown>);
  const sig   = ed25519.sign(bytes, privateKey);
  return toHex(sig);
}

// ── Verify ────────────────────────────────────────────────────────────────────

export function verifyCapsuleSignature(
  payload:   SignablePayload,
  signature: string,
  publicKey: string,
): boolean {
  try {
    const bytes    = canonicalBytes(payload as unknown as Record<string, unknown>);
    const sigBytes = fromHex(signature);
    const pkBytes  = fromHex(publicKey);
    return ed25519.verify(sigBytes, bytes, pkBytes);
  } catch {
    return false;
  }
}

// ── Capsule ID (content-addressed) ───────────────────────────────────────────

/**
 * Derive a deterministic capsule_id from the pre-ID payload (everything except
 * capsule_id and signature). Uses canonical JSON bytes → SHA-256 → hex.
 * Same payload always produces the same ID.
 */
export async function deriveCapsuleId(
  payload: PreIdPayload | Record<string, unknown>
): Promise<string> {
  const bytes  = canonicalBytes(payload as Record<string, unknown>);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return "0x" + Buffer.from(digest).toString("hex");
}
