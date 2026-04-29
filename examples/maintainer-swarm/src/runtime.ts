/**
 * runtime.ts — Generic agent runtime for MaintainerSwarm.
 *
 * Each container runs one AgentRuntime configured by AGENT_ROLE.
 *
 * Transport: ALL inter-agent messages go over /send + /recv (AXL Pattern 1).
 * The runtime is the sole owner of the /recv drain. It routes each message:
 *   - gossipsub frames   → GossipSub.ingest()
 *   - capsule.handoff    → handler → capsule write → GossipSub.publish() → /send to next role
 */

import {
  StateCapsule,
  type Capsule,
  type UpdateCapsuleInput,
  type ZeroGConfig,
  ZeroGConfigSchema,
} from "@state-capsule/sdk";
import {
  AxlClient,
  GossipSub,
  axlUrlFromEnv,
  type CapsuleEnvelope,
  type CapsuleAnnounce,
} from "@state-capsule/sdk";

// ── Types ─────────────────────────────────────────────────────────────────────

export type AgentRole = "triager" | "reproducer" | "patcher" | "reviewer";

export interface HandlerContext {
  capsule:  Capsule;
  envelope: CapsuleEnvelope;
  role:     AgentRole;
}

export interface HandlerResult {
  update:       Omit<UpdateCapsuleInput, "task_id" | "parent_capsule_id">;
  next_holder?: AgentRole;
}

export type Handler = (ctx: HandlerContext) => Promise<HandlerResult>;

export interface RuntimeConfig {
  role:            AgentRole;
  axlUrl?:         string;
  storage?:        ZeroGConfig;
  privateKey?:     string;
  pollIntervalMs?: number;
  roleToPeerId?:   Record<AgentRole, string>;
}

const CAPSULE_TOPIC = "capsule.updated";

// ── Runtime ───────────────────────────────────────────────────────────────────

export class AgentRuntime {
  private axl:      AxlClient;
  private gossip:   GossipSub | null = null;
  private sdk:      StateCapsule;
  private config:   RuntimeConfig;
  private handler:  Handler | null = null;
  private running   = false;
  private ownPeerId = "";

  constructor(config: RuntimeConfig) {
    this.config = config;
    this.axl    = new AxlClient({
      baseUrl:   config.axlUrl ?? axlUrlFromEnv(),
      timeoutMs: 30_000,  // Yggdrasil routing can take time on first send
    });

    const storageConfig = config.storage
      ? ZeroGConfigSchema.parse(config.storage)
      : undefined;

    this.sdk = new StateCapsule({
      ...(config.privateKey ? { privateKey: config.privateKey } : {}),
      ...(storageConfig ? { storage: storageConfig } : {}),
    });
  }

  register(handler: Handler): this {
    this.handler = handler;
    return this;
  }

  async start(): Promise<void> {
    if (!this.handler) throw new Error("No handler registered. Call register() first.");
    this.running = true;

    // Resolve own peer_id
    try {
      this.ownPeerId = await this.axl.ownPeerId();
      console.log(`[${this.config.role}] peer_id: ${this.ownPeerId.slice(0, 16)}...`);
    } catch (err) {
      console.warn(`[${this.config.role}] Could not resolve peer_id: ${err}`);
    }

    // Set up GossipSub
    this.gossip = new GossipSub(this.ownPeerId, this.axl);
    this.gossip.subscribe(CAPSULE_TOPIC, (data, from) => {
      try {
        const announce = JSON.parse(new TextDecoder().decode(data)) as CapsuleAnnounce;
        console.log(
          `[${this.config.role}] 📢 gossip capsule.updated task=${announce.task_id} ` +
          `holder=${announce.holder} from=${from.slice(0, 12)}...`
        );
      } catch { /* ignore malformed gossip */ }
    });

    // Discover peers
    try {
      const peers = await this.axl.connectedPeers();
      for (const p of peers) this.gossip.addPeer(p);
      console.log(`[${this.config.role}] ${peers.length} peers in gossip mesh`);
    } catch { /* non-fatal */ }

    console.log(`[${this.config.role}] Runtime started. Polling AXL inbox...`);

    const interval = this.config.pollIntervalMs ?? 500;

    while (this.running) {
      try {
        await this._pollOnce();
      } catch (err) {
        console.error(`[${this.config.role}] Poll error:`, err);
      }
      await sleep(interval);
    }
  }

  stop(): void { this.running = false; }

  // ── Single recv drain — owns the /recv queue ───────────────────────────────

  private async _pollOnce(): Promise<void> {
    const messages = await this.axl.recv(10);

    for (const msg of messages) {
      // Route: offer to gossip first; if it's a gossipsub frame it's consumed
      const consumed = await this.gossip?.ingest(msg.from, msg.data) ?? false;
      if (!consumed) {
        await this._handleHandoff(msg.data);
      }
    }

    // Heartbeat-only tick (no recv drain)
    await this.gossip?.runHeartbeat();

    // Re-discover peers periodically so gossip mesh grows as nodes join
    if (this.gossip && Math.random() < 0.05) {
      try {
        const peers = await this.axl.connectedPeers();
        for (const p of peers) this.gossip.addPeer(p);
      } catch { /* non-fatal */ }
    }
  }

  // ── Handoff handler ────────────────────────────────────────────────────────

  private async _handleHandoff(data: Uint8Array): Promise<void> {
    let envelope: CapsuleEnvelope;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
      if (parsed["type"] !== "capsule.handoff") return;
      envelope = parsed as unknown as CapsuleEnvelope;
    } catch {
      return;
    }

    console.log(
      `[${this.config.role}] ✉️  handoff task=${envelope.task_id} ` +
      `capsule=${envelope.capsule_id.slice(0, 10)}...`
    );

    // If envelope carries a genesis payload, seed our local storage first
    // so restoreCapsule works without shared 0G storage for the first hop.
    if (envelope.payload?.["capsule"]) {
      try {
        await this.sdk.bootstrapCapsule(envelope.payload["capsule"]);
      } catch { /* already stored or non-fatal */ }
    }

    // Restore capsule from storage
    let capsule: Capsule;
    try {
      capsule = await this.sdk.restoreCapsule(envelope.task_id);
    } catch (err) {
      console.error(`[${this.config.role}] restoreCapsule failed:`, err);
      return;
    }

    const ctx: HandlerContext = { capsule, envelope, role: this.config.role };
    const result = await this.handler!(ctx);

    // Write capsule update
    const updated = await this.sdk.updateCapsule({
      task_id:           capsule.task_id,
      parent_capsule_id: capsule.capsule_id,
      ...result.update,
    });

    console.log(
      `[${this.config.role}] ✅ capsule updated → ${updated.capsule_id.slice(0, 10)}...`
    );

    // Broadcast via GossipSub
    if (this.gossip) {
      const announce: CapsuleAnnounce = {
        task_id:    updated.task_id,
        capsule_id: updated.capsule_id,
        holder:     this.config.role,
        log_root:   updated.log_root,
        timestamp:  new Date().toISOString(),
      };
      await this.gossip.publish(CAPSULE_TOPIC, new TextEncoder().encode(JSON.stringify(announce)));
    }

    // Forward handoff to next role via /send
    if (result.next_holder) {
      await this._forwardHandoff(updated, result.next_holder);
    } else {
      console.log(`[${this.config.role}] 🏁 pipeline complete for task ${updated.task_id}`);
    }
  }

  private async _forwardHandoff(capsule: Capsule, nextRole: AgentRole): Promise<void> {
    // Try config first, then fall back to live /peers/ registry file
    let nextPeerId = this.config.roleToPeerId?.[nextRole];

    if (!nextPeerId) {
      const peersDir = process.env["PEERS_DIR"] ?? "/peers";
      try {
        const { readFileSync } = await import("node:fs");
        const id = readFileSync(`${peersDir}/${nextRole}`, "utf8").trim();
        if (id) {
          nextPeerId = id;
          // Cache it so we don't re-read on every forward
          if (!this.config.roleToPeerId) this.config.roleToPeerId = {} as Record<AgentRole, string>;
          this.config.roleToPeerId[nextRole] = id;
          console.log(`[${this.config.role}] Discovered ${nextRole} peer_id: ${id.slice(0, 16)}...`);
        }
      } catch { /* peer not registered yet */ }
    }

    if (!nextPeerId) {
      console.warn(
        `[${this.config.role}] No peer_id for "${nextRole}" yet. ` +
        `Will retry on next handoff.`
      );
      return;
    }

    const envelope: CapsuleEnvelope = {
      type:        "capsule.handoff",
      task_id:     capsule.task_id,
      capsule_id:  capsule.capsule_id,
      holder:      this.config.role,
      next_holder: nextRole,
      log_root:    capsule.log_root,
      payload:     { capsule },  // carry genesis data for in-memory bootstrap
      sent_at:     new Date().toISOString(),
    };

    // Retry up to 3 times — first send may fail while Yggdrasil route resolves
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.axl.sendEnvelope(nextPeerId, envelope);
        console.log(
          `[${this.config.role}] ➡️  forwarded to ${nextRole} (${nextPeerId.slice(0, 12)}...)`
        );
        return;
      } catch (err) {
        lastErr = err;
        console.warn(`[${this.config.role}] /send attempt ${attempt}/3 failed: ${err}`);
        if (attempt < 3) await sleep(2000 * attempt);
      }
    }
    console.error(`[${this.config.role}] Failed to forward to ${nextRole} after 3 attempts:`, lastErr);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function resolveRolePeerIds(
  _axl: AxlClient,
  roles: AgentRole[]
): Promise<Partial<Record<AgentRole, string>>> {
  const result: Partial<Record<AgentRole, string>> = {};
  for (const role of roles) {
    const val = process.env[`PEER_ID_${role.toUpperCase()}`];
    if (val) result[role] = val;
  }
  return result;
}
