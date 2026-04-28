/**
 * api.ts — Core SDK surface.
 *
 * createCapsule   → genesis capsule for a new task
 * updateCapsule   → extend a capsule chain with new state
 * restoreCapsule  → fetch + verify the latest capsule for a task_id
 *                   (works in a process that has never seen the task)
 * verifyHandoff   → verify the full signature chain from genesis to tip
 */

import { CapsuleSchema, type Capsule, type ZeroGConfig } from "./schema.js";
import {
  generateKeyPair,
  signCapsule,
  verifyCapsuleSignature,
  deriveCapsuleId,
  toHex,
  fromHex,
  publicKeyFromPrivate,
} from "./sign.js";
import { type StorageAdapter, createStorage, createMemoryStorage } from "./storage.js";
import { migrateCapsule } from "./migrations.js";
import { SCHEMA_VERSION } from "./schema.js";

// ── SDK client ────────────────────────────────────────────────────────────────

export interface StateCapsuleConfig {
  /**
   * ed25519 private key as hex string (0x-prefixed, 32 bytes).
   * If omitted, a random key is generated (useful for tests).
   */
  privateKey?: string;

  /**
   * 0G storage config. If omitted, falls back to in-memory storage
   * (useful for unit tests that don't need real 0G).
   */
  storage?: ZeroGConfig;

  /**
   * Pass an explicit StorageAdapter to override the default (testing).
   */
  storageAdapter?: StorageAdapter;
}

export interface CreateCapsuleInput {
  task_id:         string;
  goal:            string;
  holder:          string;
  facts?:          string[];
  constraints?:    string[];
  decisions?:      string[];
  pending_actions?: string[];
  next_action?:    string;
  counterparties?: string[];
  task_pointer?:   string;
}

export interface UpdateCapsuleInput {
  task_id:          string;
  parent_capsule_id: string;
  holder:           string;
  facts?:           string[];
  constraints?:     string[];
  decisions?:       string[];
  pending_actions?: string[];
  next_action?:     string;
  counterparties?:  string[];
  log_root?:        string | null;
  task_pointer?:    string;
}

// KV key for the latest capsule blob hash
function kvKey(task_id: string): string {
  return `sc:head:${task_id}`;
}

// KV key for the capsule chain (ordered list of capsule_ids)
function kvChainKey(task_id: string): string {
  return `sc:chain:${task_id}`;
}

// ── StateCapsule client ───────────────────────────────────────────────────────

export class StateCapsule {
  private adapter:    StorageAdapter;
  private privateKey: Uint8Array;
  private publicKey:  Uint8Array;

  constructor(config: StateCapsuleConfig = {}) {
    // Private key
    if (config.privateKey) {
      this.privateKey = fromHex(config.privateKey);
    } else {
      const kp = generateKeyPair();
      this.privateKey = kp.privateKey;
    }
    this.publicKey = publicKeyFromPrivate(this.privateKey);

    // Storage adapter
    if (config.storageAdapter) {
      this.adapter = config.storageAdapter;
    } else if (config.storage) {
      this.adapter = createStorage(config.storage);
    } else {
      this.adapter = createMemoryStorage();
    }
  }

  get publicKeyHex(): string {
    return toHex(this.publicKey);
  }

  // ── createCapsule ──────────────────────────────────────────────────────────

  async createCapsule(input: CreateCapsuleInput): Promise<Capsule> {
    const now = new Date().toISOString();

    // Build signable payload (no capsule_id or signature yet)
    const signable = {
      task_id:           input.task_id,
      schema_version:    SCHEMA_VERSION,
      parent_capsule_id: null,
      created_by:        toHex(this.publicKey),
      created_at:        now,
      goal:              input.goal,
      facts:             input.facts            ?? [],
      constraints:       input.constraints      ?? [],
      decisions:         input.decisions        ?? [],
      pending_actions:   input.pending_actions  ?? [],
      next_action:       input.next_action      ?? "",
      counterparties:    input.counterparties   ?? [],
      log_root:          null,
      holder:            input.holder,
      ...(input.task_pointer ? { task_pointer: input.task_pointer } : {}),
    };

    const capsule_id = await deriveCapsuleId(signable);
    const signableWithId = { ...signable, capsule_id };
    const signature  = signCapsule(signableWithId, this.privateKey);

    const capsule = CapsuleSchema.parse({ ...signableWithId, signature });
    await this._persist(capsule);
    return capsule;
  }

  // ── updateCapsule ──────────────────────────────────────────────────────────

  async updateCapsule(input: UpdateCapsuleInput): Promise<Capsule> {
    // Fetch current head to inherit immutable fields
    const head = await this.restoreCapsule(input.task_id);
    const now  = new Date().toISOString();

    const signable = {
      task_id:           input.task_id,
      schema_version:    SCHEMA_VERSION,
      parent_capsule_id: head.capsule_id,
      created_by:        toHex(this.publicKey),
      created_at:        now,
      goal:              head.goal,
      facts:             input.facts            ?? head.facts,
      constraints:       input.constraints      ?? head.constraints,
      decisions:         input.decisions        ?? head.decisions,
      pending_actions:   input.pending_actions  ?? head.pending_actions,
      next_action:       input.next_action      ?? head.next_action,
      counterparties:    input.counterparties   ?? head.counterparties,
      log_root:          input.log_root         ?? head.log_root,
      holder:            input.holder,
      ...(input.task_pointer
        ? { task_pointer: input.task_pointer }
        : head.task_pointer
        ? { task_pointer: head.task_pointer }
        : {}),
    };

    const capsule_id = await deriveCapsuleId(signable);
    const signableWithId = { ...signable, capsule_id };
    const signature  = signCapsule(signableWithId, this.privateKey);

    const capsule = CapsuleSchema.parse({ ...signableWithId, signature });
    await this._persist(capsule);
    return capsule;
  }

  // ── restoreCapsule ─────────────────────────────────────────────────────────

  /**
   * Restore the latest capsule for a task. Works in a fresh process with no
   * prior in-memory state — reads head from 0G KV, fetches blob by root hash.
   */
  async restoreCapsule(task_id: string): Promise<Capsule> {
    // 1. Read the current head blob hash from KV
    const headBytes = await this.adapter.kvGet(kvKey(task_id));
    if (!headBytes) {
      throw new Error(`No capsule found for task_id: ${task_id}`);
    }
    const rootHash = new TextDecoder().decode(headBytes);

    // 2. Fetch the blob
    const blobBytes = await this.adapter.blobRead(rootHash);
    const raw = JSON.parse(new TextDecoder().decode(blobBytes)) as Record<string, unknown>;

    // 3. Migrate if needed
    const migrated = migrateCapsule(raw);

    // 4. Validate schema
    return CapsuleSchema.parse(migrated);
  }

  // ── verifyHandoff ──────────────────────────────────────────────────────────

  /**
   * Verify the signature chain from genesis (parent_capsule_id=null) to the
   * given capsule. Returns true only if every capsule in the chain has a valid
   * signature. Does NOT re-fetch — requires all capsule objects to be provided.
   *
   * For a full chain verification from storage, fetch each capsule in the chain
   * via its blob hash and pass them here in order (genesis first).
   */
  async verifyHandoff(chain: Capsule[]): Promise<boolean> {
    if (chain.length === 0) return false;

    for (const capsule of chain) {
      const { signature, ...signable } = capsule;
      const valid = verifyCapsuleSignature(signable, signature, capsule.created_by);
      if (!valid) return false;
    }

    // Verify parent_capsule_id linkage
    for (let i = 1; i < chain.length; i++) {
      const prev = chain[i - 1];
      const curr = chain[i];
      if (!prev || !curr) return false;
      if (curr.parent_capsule_id !== prev.capsule_id) return false;
    }

    return true;
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  private async _persist(capsule: Capsule): Promise<void> {
    const encoded = new TextEncoder().encode(JSON.stringify(capsule));

    // Write blob (immutable)
    const rootHash = await this.adapter.blobWrite(encoded);

    // Update KV head pointer: task_id → rootHash
    await this.adapter.kvSet(kvKey(capsule.task_id), new TextEncoder().encode(rootHash));

    // Append to chain log: task_id → [...previous_ids, capsule_id]
    const existing = await this.adapter.kvGet(kvChainKey(capsule.task_id));
    const chain: string[] = existing
      ? JSON.parse(new TextDecoder().decode(existing)) as string[]
      : [];
    chain.push(capsule.capsule_id);
    await this.adapter.kvSet(
      kvChainKey(capsule.task_id),
      new TextEncoder().encode(JSON.stringify(chain))
    );
  }
}

// ── Convenience functional API ────────────────────────────────────────────────

let _defaultClient: StateCapsule | null = null;

function getDefaultClient(): StateCapsule {
  if (!_defaultClient) _defaultClient = new StateCapsule();
  return _defaultClient;
}

export function configureCapsule(config: StateCapsuleConfig): StateCapsule {
  _defaultClient = new StateCapsule(config);
  return _defaultClient;
}

export async function createCapsule(
  input: CreateCapsuleInput,
  client?: StateCapsule
): Promise<Capsule> {
  return (client ?? getDefaultClient()).createCapsule(input);
}

export async function updateCapsule(
  input: UpdateCapsuleInput,
  client?: StateCapsule
): Promise<Capsule> {
  return (client ?? getDefaultClient()).updateCapsule(input);
}

export async function restoreCapsule(
  task_id: string,
  client?: StateCapsule
): Promise<Capsule> {
  return (client ?? getDefaultClient()).restoreCapsule(task_id);
}

export async function verifyHandoff(
  chain: Capsule[],
  client?: StateCapsule
): Promise<boolean> {
  return (client ?? getDefaultClient()).verifyHandoff(chain);
}
