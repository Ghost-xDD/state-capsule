/**
 * runtime.ts — Generic agent runtime for MaintainerSwarm.
 *
 * Each container runs one instance of this runtime configured by AGENT_ROLE.
 * The runtime:
 *   1. Connects to the local AXL daemon
 *   2. Polls the inbox for CapsuleEnvelope messages
 *   3. Dispatches to the registered handler for the agent's role
 *   4. Persists the capsule update via the SDK
 *   5. Broadcasts a capsule.updated GossipSub announce
 *   6. Forwards the handoff to the next role's AXL peer
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
  update:      Omit<UpdateCapsuleInput, "task_id" | "parent_capsule_id">;
  next_holder?: AgentRole;   // undefined = terminal (reviewer done)
}

export type Handler = (ctx: HandlerContext) => Promise<HandlerResult>;

export interface RuntimeConfig {
  role:          AgentRole;
  axlUrl?:       string;
  storage?:      ZeroGConfig;
  privateKey?:   string;
  pollIntervalMs?: number;
  /** Peer ID → AXL base URL map (populated at startup from /topology) */
  peers?:        Record<string, string>;
  /** Role → peer_id map (resolved via /topology on startup) */
  roleToPeerId?: Record<AgentRole, string>;
}

// ── Runtime ───────────────────────────────────────────────────────────────────

export class AgentRuntime {
  private axl:     AxlClient;
  private sdk:     StateCapsule;
  private config:  RuntimeConfig;
  private handler: Handler | null = null;
  private running  = false;

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

    // Subscribe to GossipSub capsule.updated topic
    try {
      await this.axl.gossipSubscribe();
    } catch {
      console.warn(`[${this.config.role}] GossipSub subscribe failed — continuing without`);
    }

    console.log(`[${this.config.role}] Runtime started. Polling AXL inbox...`);

    const interval = this.config.pollIntervalMs ?? 1_000;

    while (this.running) {
      try {
        await this._pollOnce();
      } catch (err) {
        console.error(`[${this.config.role}] Poll error:`, err);
      }
      await sleep(interval);
    }
  }

  stop(): void {
    this.running = false;
  }

  private async _pollOnce(): Promise<void> {
    const messages = await this.axl.recv(5);
    for (const msg of messages) {
      await this._handleMessage(msg);
    }
  }

  parseEnvelope(msg: AxlMessage): CapsuleEnvelope | null {
    return this.axl.parseEnvelope(msg);
  }
    if (!envelope) {
      console.warn(`[${this.config.role}] Unparseable message from ${msg.from}`);
      return;
    }

    if (envelope.type !== "capsule.handoff") return;

    console.log(
      `[${this.config.role}] Received handoff for task ${envelope.task_id} ` +
      `(capsule ${envelope.capsule_id.slice(0, 10)}...)`
    );

    // Restore the capsule from storage
    let capsule: Capsule;
    try {
      capsule = await this.sdk.restoreCapsule(envelope.task_id);
    } catch (err) {
      console.error(`[${this.config.role}] restoreCapsule failed:`, err);
      return;
    }

    const ctx: HandlerContext = {
      capsule,
      envelope,
      role: this.config.role,
    };

    // Run the handler
    const result = await this.handler!(ctx);

    // Write the capsule update
    const updated = await this.sdk.updateCapsule({
      task_id:           capsule.task_id,
      parent_capsule_id: capsule.capsule_id,
      ...result.update,
    });

    console.log(
      `[${this.config.role}] Capsule updated → ${updated.capsule_id.slice(0, 10)}...`
    );

    // Broadcast capsule.updated via GossipSub
    const announce: CapsuleAnnounce = {
      task_id:    updated.task_id,
      capsule_id: updated.capsule_id,
      holder:     this.config.role,
      log_root:   updated.log_root,
      timestamp:  new Date().toISOString(),
    };
    await this.axl.broadcastCapsuleUpdated(announce);

    // Forward handoff to next role
    if (result.next_holder) {
      await this._forwardHandoff(updated, result.next_holder);
    } else {
      console.log(`[${this.config.role}] Task ${updated.task_id} — pipeline complete ✅`);
    }
  }

  private async _forwardHandoff(capsule: Capsule, nextRole: AgentRole): Promise<void> {
    const nextPeerId = this.config.roleToPeerId?.[nextRole];
    if (!nextPeerId) {
      console.warn(
        `[${this.config.role}] No peer_id for role "${nextRole}" — ` +
        `set roleToPeerId in config or resolve from /topology`
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
    console.log(`[${this.config.role}] Forwarded handoff to ${nextRole} (${nextPeerId.slice(0, 16)}...)`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve roleToPeerId from /topology.
 * Each AXL node announces its role as part of its peer metadata.
 * Fallback: read ROLE_<UPPERCASE>_PEER_ID env vars.
 */
export async function resolveRolePeerIds(
  axl: AxlClient,
  roles: AgentRole[]
): Promise<Record<AgentRole, string>> {
  const result = {} as Record<AgentRole, string>;

  // Try env vars first (set via docker-compose environment)
  for (const role of roles) {
    const envKey = `PEER_ID_${role.toUpperCase()}`;
    const val    = process.env[envKey];
    if (val) result[role] = val;
  }

  // Fill in any missing from topology
  const missing = roles.filter((r) => !result[r]);
  if (missing.length > 0) {
    try {
      const topo = await axl.topology();
      for (const peer of topo.peers) {
        // Peers announce their role in a conventional format:
        // peer metadata (not part of AXL spec yet, so we rely on env vars)
        console.warn(`[runtime] Peer ${peer.peer_id} — role resolution via topology not yet implemented. Set PEER_ID_<ROLE> env vars.`);
      }
    } catch (err) {
      console.warn(`[runtime] topology fetch failed: ${err}`);
    }
  }

  return result;
}
