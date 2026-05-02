/**
 * api.ts — Core SDK surface.
 *
 * createCapsule   → genesis capsule for a new task
 * updateCapsule   → extend a capsule chain with new state, anchored on-chain
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
import {
  ChainAnchor,
  isStaleParentError,
  taskIdToBytes32,
  type ChainConfig,
} from "./chain.js";

// ── SDK config ────────────────────────────────────────────────────────────────

export interface StateCapsuleConfig {
  /**
   * ed25519 private key as hex string (0x-prefixed, 32 bytes).
   * If omitted, a random key is generated (useful for tests).
   */
  privateKey?: string;

  /**
   * 0G Storage config. If omitted, falls back to in-memory storage.
   */
  storage?: ZeroGConfig;

  /**
   * Pass an explicit StorageAdapter to override the default (testing).
   */
  storageAdapter?: StorageAdapter;

  /**
   * On-chain anchor config. If omitted, anchor calls are skipped
   * (useful for unit tests and offline usage).
   */
  chain?: ChainConfig;

  /**
   * Called after every successful createCapsule / updateCapsule.
   * Intended for ENS task-pointer updates and other side-effects.
   * MUST NOT throw — wrap in try/catch at the call site.
   * Failures are logged as warnings; the capsule write is never blocked.
   */
  onAfterUpdate?: (capsule: Capsule) => Promise<void>;
}

export interface CreateCapsuleInput {
  task_id:          string;
  goal:             string;
  holder:           string;
  facts?:           string[];
  constraints?:     string[];
  decisions?:       string[];
  pending_actions?: string[];
  next_action?:     string;
  counterparties?:  string[];
  task_pointer?:    string;
}

export interface UpdateCapsuleInput {
  task_id:           string;
  parent_capsule_id: string;
  holder:            string;
  facts?:            string[];
  constraints?:      string[];
  decisions?:        string[];
  pending_actions?:  string[];
  next_action?:      string;
  counterparties?:   string[];
  log_root?:         string | null;
  task_pointer?:     string;
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
  private adapter:          StorageAdapter;
  private privateKey:       Uint8Array;
  private publicKey:        Uint8Array;
  private chain:            ChainAnchor | null;
  private onAfterUpdate:    ((capsule: Capsule) => Promise<void>) | null;
  /** In-process cache: capsule_id → Capsule (avoids round-trips for same-process pipelines) */
  private _cache = new Map<string, Capsule>();
  /** In-process chain log: task_id → ordered list of capsule_ids */
  private _chains = new Map<string, string[]>();

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

    // On-chain anchor (optional)
    this.chain = config.chain ? new ChainAnchor(config.chain) : null;

    // Post-write side-effect hook (ENS, metrics, etc.)
    this.onAfterUpdate = config.onAfterUpdate ?? null;
  }

  get publicKeyHex(): string {
    return toHex(this.publicKey);
  }

  /**
   * Seed a capsule into local storage without creating a new signed update.
   * Used by agents when receiving a genesis capsule embedded in a handoff
   * envelope (allows first-hop bootstrap without shared 0G storage).
   */
  async bootstrapCapsule(raw: unknown): Promise<void> {
    const capsule = CapsuleSchema.parse(raw);
    await this._persist(capsule);
  }

  // ── createCapsule ──────────────────────────────────────────────────────────

  async createCapsule(input: CreateCapsuleInput): Promise<Capsule> {
    const now = new Date().toISOString();

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

    const capsule_id    = await deriveCapsuleId(signable);
    const signableWithId = { ...signable, capsule_id };
    const signature     = signCapsule(signableWithId, this.privateKey);
    const capsule       = CapsuleSchema.parse({ ...signableWithId, signature });

    await this._persist(capsule);

    // Anchor genesis on-chain — treated as best-effort like updateCapsule.
    // StaleParent means another genesis was already anchored (e.g. from a
    // previous run with the same task_id); we accept that gracefully.
    await this._anchorWithRebase(capsule);

    await this._runAfterUpdate(capsule);
    this._cache.set(capsule.capsule_id, capsule);
    return capsule;
  }

  // ── updateCapsule ──────────────────────────────────────────────────────────

  async updateCapsule(input: UpdateCapsuleInput): Promise<Capsule> {
    const capsule = await this._buildUpdate(input);
    await this._persist(capsule);
    await this._anchorWithRebase(capsule);
    await this._runAfterUpdate(capsule);
    this._cache.set(capsule.capsule_id, capsule);
    return capsule;
  }

  // ── restoreCapsule ─────────────────────────────────────────────────────────

  /**
   * Restore the latest capsule for a task. Works in a fresh process with no
   * prior in-memory state — reads head from 0G KV, fetches blob by root hash.
   */
  async restoreCapsule(task_id: string): Promise<Capsule> {
    // Fast path: check the in-memory chain log (same-process pipeline).
    const chain = this._chains.get(task_id);
    if (chain && chain.length > 0) {
      const latestId = chain[chain.length - 1]!;
      const cached = this._cache.get(latestId);
      if (cached) return cached;
    }

    // Cold-start path: ask KV for the head pointer, then fetch the blob.
    // KV may not have indexed the latest writes yet (async sync lag), so
    // this is best-effort — throws only if both paths are unavailable.
    const headBytes = await this.adapter.kvGet(kvKey(task_id));
    if (!headBytes) {
      throw new Error(`No capsule found for task_id: ${task_id}`);
    }
    const rootHash = new TextDecoder().decode(headBytes);
    const blobBytes = await this.adapter.blobRead(rootHash);
    const raw = JSON.parse(new TextDecoder().decode(blobBytes)) as Record<string, unknown>;
    return CapsuleSchema.parse(migrateCapsule(raw));
  }

  // ── verifyHandoff ──────────────────────────────────────────────────────────

  /**
   * Verify the full ed25519 signature chain and parent linkage.
   * Pass capsules in order from genesis (index 0) to tip.
   */
  async verifyHandoff(chain: Capsule[]): Promise<boolean> {
    if (chain.length === 0) return false;

    for (const capsule of chain) {
      const { signature, ...signable } = capsule;
      if (!verifyCapsuleSignature(signable, signature, capsule.created_by)) return false;
    }

    for (let i = 1; i < chain.length; i++) {
      const prev = chain[i - 1];
      const curr = chain[i];
      if (!prev || !curr) return false;
      if (curr.parent_capsule_id !== prev.capsule_id) return false;
    }

    return true;
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  /**
   * Fire-and-forget hook for side-effects (ENS, metrics, …).
   * Never propagates errors — logs warnings instead.
   */
  private async _runAfterUpdate(capsule: Capsule): Promise<void> {
    if (this.onAfterUpdate === null) return;
    try {
      await this.onAfterUpdate(capsule);
    } catch (err) {
      console.warn(`[sdk] onAfterUpdate hook failed (non-fatal): ${err}`);
    }
  }

  private async _buildUpdate(input: UpdateCapsuleInput): Promise<Capsule> {
    // Use the explicit parent if provided (in-process pipeline, no KV needed).
    // Fall back to KV restore only for cross-process cold-starts.
    const head = input.parent_capsule_id && this._cache.has(input.parent_capsule_id)
      ? this._cache.get(input.parent_capsule_id)!
      : await this.restoreCapsule(input.task_id);
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

    const capsule_id    = await deriveCapsuleId(signable);
    const signableWithId = { ...signable, capsule_id };
    const signature     = signCapsule(signableWithId, this.privateKey);
    return CapsuleSchema.parse({ ...signableWithId, signature });
  }

  private async _persist(capsule: Capsule): Promise<void> {
    const encoded  = new TextEncoder().encode(JSON.stringify(capsule));
    const rootHash = await this.adapter.blobWrite(encoded);

    // ── In-memory chain log (fast path, no KV round-trip) ────────────────
    const chain = this._chains.get(capsule.task_id) ?? [];
    chain.push(capsule.capsule_id);
    this._chains.set(capsule.task_id, chain);

    // ── KV writes: sequential, after blob, non-blocking to the caller ─────
    // Fired as a single microtask AFTER blobWrite completes so they don't
    // race with the blob Batcher for the same wallet nonce.
    // We intentionally do not await — the caller's pipeline continues.
    void (async () => {
      try {
        await this.adapter.kvSet(kvKey(capsule.task_id), new TextEncoder().encode(rootHash));
      } catch (e) {
        console.warn(`[0G KV] head-write failed (non-fatal): ${(e as Error).message}`);
      }
      try {
        await this.adapter.kvSet(
          kvChainKey(capsule.task_id),
          new TextEncoder().encode(JSON.stringify(chain)),
        );
      } catch (e) {
        console.warn(`[0G KV] chain-write failed (non-fatal): ${(e as Error).message}`);
      }
    })();
  }

  /**
   * Anchor on-chain. On StaleParent revert, rebase once and retry.
   *
   * The entire anchor is wrapped so that KV unavailability (which prevents
   * rebase) never kills a pipeline — blobs are the primary store, the
   * on-chain anchor is a best-effort audit trail.
   */
  private async _anchorWithRebase(capsule: Capsule): Promise<void> {
    if (!this.chain) return;

    const ZERO    = "0x" + "00".repeat(32);
    const logRoot = capsule.log_root ?? ZERO;
    const taskB32 = taskIdToBytes32(capsule.task_id);

    const doAnchor = (parent: string, id: string, lr: string) =>
      this.chain!.anchor(taskB32, parent, id, lr);

    try {
      await doAnchor(capsule.parent_capsule_id ?? ZERO, capsule.capsule_id, logRoot);
    } catch (firstErr) {
      if (!isStaleParentError(firstErr)) {
        console.warn(`[chain] anchor failed (non-fatal): ${(firstErr as Error).message}`);
        return;
      }

      // StaleParent: rebase once onto the on-chain tip, then retry.
      try {
        const onChainHead = await this.chain.head(taskB32);
        const rebased = await this._buildUpdate({
          task_id:           capsule.task_id,
          parent_capsule_id: onChainHead.capsuleId,
          holder:            capsule.holder,
          facts:             capsule.facts,
          constraints:       capsule.constraints,
          decisions:         capsule.decisions,
          pending_actions:   capsule.pending_actions,
          next_action:       capsule.next_action,
          counterparties:    capsule.counterparties,
          log_root:          capsule.log_root,
          ...(capsule.task_pointer ? { task_pointer: capsule.task_pointer } : {}),
        });

        await this._persist(rebased);
        await doAnchor(
          rebased.parent_capsule_id ?? ZERO,
          rebased.capsule_id,
          rebased.log_root ?? ZERO,
        );
      } catch (rebaseErr) {
        console.warn(`[chain] anchor rebase failed (non-fatal): ${(rebaseErr as Error).message}`);
      }
    }
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
