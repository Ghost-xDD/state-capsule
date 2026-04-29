/**
 * runtime.ts — Generic agent runtime for MaintainerSwarm.
 *
 * Each container runs one instance of this runtime configured by AGENT_ROLE.
 * The runtime:
 *   1. Connects to the local AXL daemon, resolves own peer_id
 *   2. Subscribes GossipSub to "capsule.updated" topic
 *   3. Polls /recv for CapsuleEnvelope handoff messages (type="capsule.handoff")
 *   4. Dispatches to the registered handler for the agent's role
 *   5. Persists the capsule update via the SDK
 *   6. Broadcasts capsule.updated via GossipSub
 *   7. Forwards the handoff to the next role via /a2a/
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
  type AxlMessage,
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
      timeoutMs: 15_000,
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

    // Discover and add peers to gossip mesh
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
        // Run GossipSub tick on same cadence
        await this.gossip.tick();
      } catch (err) {
        console.error(`[${this.config.role}] Poll error:`, err);
      }
      await sleep(interval);
    }
  }

  stop(): void { this.running = false; }

  // ── Poll ──────────────────────────────────────────────────────────────────

  private async _pollOnce(): Promise<void> {
    const messages = await this.axl.recv(5);
    for (const msg of messages) {
      await this._handleMessage(msg);
    }
  }

  private async _handleMessage(msg: AxlMessage): Promise<void> {
    // Skip gossipsub frames — handled by GossipSub.tick()
    const text = new TextDecoder().decode(msg.data);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      console.warn(`[${this.config.role}] Non-JSON message from ${msg.from.slice(0, 12)}...`);
      return;
    }

    if (parsed["type"] === "gossipsub") return; // handled by gossip.tick()

    const envelope = parsed as unknown as CapsuleEnvelope;
    if (envelope.type !== "capsule.handoff") return;

    console.log(
      `[${this.config.role}] ✉️  handoff for task=${envelope.task_id} ` +
      `capsule=${envelope.capsule_id.slice(0, 10)}...`
    );

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
      const data = new TextEncoder().encode(JSON.stringify(announce));
      await this.gossip.publish(CAPSULE_TOPIC, data);
    }

    // Forward handoff to next role
    if (result.next_holder) {
      await this._forwardHandoff(updated, result.next_holder);
    } else {
      console.log(`[${this.config.role}] 🏁 task ${updated.task_id} — pipeline complete`);
    }
  }

  private async _forwardHandoff(capsule: Capsule, nextRole: AgentRole): Promise<void> {
    const nextPeerId = this.config.roleToPeerId?.[nextRole];
    if (!nextPeerId) {
      console.warn(
        `[${this.config.role}] No peer_id for role "${nextRole}". ` +
        `Set PEER_ID_${nextRole.toUpperCase()} env var.`
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
      sent_at:     new Date().toISOString(),
    };

    await this.axl.a2a(nextPeerId, envelope);
    console.log(
      `[${this.config.role}] ➡️  forwarded to ${nextRole} (${nextPeerId.slice(0, 12)}...)`
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function resolveRolePeerIds(
  axl: AxlClient,
  roles: AgentRole[]
): Promise<Record<AgentRole, string>> {
  const result = {} as Record<AgentRole, string>;

  for (const role of roles) {
    const val = process.env[`PEER_ID_${role.toUpperCase()}`];
    if (val) result[role] = val;
  }

  return result;
}
