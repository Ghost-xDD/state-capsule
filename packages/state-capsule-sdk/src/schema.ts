import { z } from "zod";

export const SCHEMA_VERSION = "0.1.0";

// Hex string validators
const Hex32 = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/i, "must be a 0x-prefixed 32-byte hex string");

const HexBytes = z
  .string()
  .regex(/^0x[0-9a-f]*$/i, "must be a 0x-prefixed hex string");

// ── Capsule schema ────────────────────────────────────────────────────────────

export const CapsuleSchema = z.object({
  // Identity
  capsule_id:        Hex32,
  task_id:           z.string().min(1),
  schema_version:    z.string().default(SCHEMA_VERSION),
  parent_capsule_id: Hex32.nullable(),   // null on genesis capsule

  // Authorship
  created_by:  HexBytes,   // ed25519 public key (hex)
  created_at:  z.string().datetime(),
  signature:   HexBytes,   // ed25519 sig over canonicalized payload (hex)

  // Task state
  goal:            z.string().min(1),
  facts:           z.array(z.string()).default([]),
  constraints:     z.array(z.string()).default([]),
  decisions:       z.array(z.string()).default([]),
  pending_actions: z.array(z.string()).default([]),
  next_action:     z.string().default(""),
  counterparties:  z.array(z.string()).default([]),

  // Storage anchors
  log_root:   Hex32.nullable().default(null),
  holder:     z.string().default(""),     // current agent role name

  // Optional ENS task pointer
  task_pointer: z.string().optional(),   // e.g. "task-1234.maintainerswarm.eth"
});

export type Capsule = z.infer<typeof CapsuleSchema>;

// Unsigned capsule — everything except `capsule_id` and `signature`, which are
// computed. Used as input to createCapsule / updateCapsule.
export const CapsuleInputSchema = CapsuleSchema.omit({
  capsule_id: true,
  signature:  true,
});

export type CapsuleInput = z.infer<typeof CapsuleInputSchema>;

// Pre-ID payload: everything except capsule_id and signature.
// This is what gets hashed to produce capsule_id.
export const PreIdPayloadSchema = CapsuleSchema.omit({
  capsule_id: true,
  signature:  true,
});

export type PreIdPayload = z.infer<typeof PreIdPayloadSchema>;

// The payload that is canonicalized and signed (includes capsule_id, excludes signature)
export const SignablePayloadSchema = CapsuleSchema.omit({ signature: true });

export type SignablePayload = z.infer<typeof SignablePayloadSchema>;

// ── Handoff summary (from 0G Compute sealed inference) ───────────────────────

export const HandoffSummarySchema = z.object({
  task_id:       z.string(),
  capsule_id:    Hex32,
  summary:       z.string(),
  next_action:   z.string(),
  confidence:    z.enum(["high", "medium", "low"]),
  produced_at:   z.string().datetime(),
  model:         z.string(),
});

export type HandoffSummary = z.infer<typeof HandoffSummarySchema>;

// ── Storage config ────────────────────────────────────────────────────────────

export const ZeroGConfigSchema = z.object({
  privateKey:       z.string(),
  evmRpc:           z.string().url().default("https://evmrpc-testnet.0g.ai"),
  indexerRpc:       z.string().url().default("https://indexer-storage-testnet-turbo.0g.ai"),
  flowContract:     z.string().default("0x22E03a6A89B950F1c82ec5e74F8eCa321a105296"),
  kvClientUrl:      z.string().url().default("http://3.101.147.150:6789"),
  kvStreamId:       z.string().default(
    // sha256("state-capsule-v1") — deterministic stream ID for all SDK data
    "0x7a8b2231ea482419d127aa35d1d3480b79b6ebcdfe0e6fdec7e574ca5569963a"
  ),
});

export type ZeroGConfig = z.infer<typeof ZeroGConfigSchema>;
