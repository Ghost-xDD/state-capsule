/**
 * axl.ts — Typed HTTP client for a local Gensyn AXL daemon.
 *
 * AXL exposes a local HTTP API (default: http://127.0.0.1:<AXL_API_PORT>).
 * This wrapper covers:
 *   POST /send            — point-to-point message to a peer
 *   GET  /recv            — poll inbox for incoming messages
 *   POST /a2a/            — agent-to-agent handoff (structured envelope)
 *   GET  /topology        — list peers and own peer_id
 *   POST /gossipsub/publish   — broadcast to a topic (capsule.updated)
 *   POST /gossipsub/subscribe — subscribe to a topic
 *   GET  /gossipsub/messages  — poll for received gossip messages
 *
 * Message envelope (for /a2a/ and /send):
 *   { type, task_id, capsule_id, holder, payload? }
 *
 * GossipSub announce (capsule.updated topic):
 *   { task_id, capsule_id, holder, log_root, timestamp }
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type MessageType =
  | "capsule.handoff"   // primary handoff: next agent should restore + continue
  | "capsule.updated"   // announce: mesh broadcast (gossipsub)
  | "capsule.request"   // request latest capsule for a task
  | "capsule.response"; // response to a request

export interface CapsuleEnvelope {
  type:        MessageType;
  task_id:     string;
  capsule_id:  string;
  holder:      string;
  log_root?:   string | null;
  next_holder?: string;         // who should pick this up
  payload?:    Record<string, unknown>;
  sent_at:     string;          // ISO timestamp
}

export interface AxlTopology {
  peer_id: string;
  peers:   Array<{ peer_id: string; address: string }>;
}

export interface AxlMessage {
  from:    string;
  payload: string;   // JSON-encoded CapsuleEnvelope
  received_at?: string;
}

export interface GossipMessage {
  topic:   string;
  from:    string;
  payload: string;   // JSON-encoded CapsuleAnnounce
  seq:     number;
}

export interface CapsuleAnnounce {
  task_id:    string;
  capsule_id: string;
  holder:     string;
  log_root?:  string | null;
  timestamp:  string;
}

// ── Client ────────────────────────────────────────────────────────────────────

export interface AxlClientConfig {
  /** Base URL of the local AXL HTTP API, e.g. http://127.0.0.1:9101 */
  baseUrl: string;
  /** Optional request timeout in ms (default: 10 000) */
  timeoutMs?: number;
}

export class AxlClient {
  private base: string;
  private timeoutMs: number;

  constructor(config: AxlClientConfig) {
    this.base      = config.baseUrl.replace(/\/$/, "");
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  // ── Topology ────────────────────────────────────────────────────────────────

  async topology(): Promise<AxlTopology> {
    return this._get<AxlTopology>("/topology");
  }

  async ownPeerId(): Promise<string> {
    const topo = await this.topology();
    return topo.peer_id;
  }

  // ── Point-to-point (/send + /recv) ──────────────────────────────────────────

  async send(toPeerId: string, envelope: CapsuleEnvelope): Promise<void> {
    await this._post("/send", {
      to:      toPeerId,
      payload: JSON.stringify(envelope),
    });
  }

  async recv(maxMessages = 10): Promise<AxlMessage[]> {
    const result = await this._get<{ messages: AxlMessage[] }>(
      `/recv?limit=${maxMessages}`
    );
    return result.messages ?? [];
  }

  // ── Agent-to-agent (/a2a/) ─────────────────────────────────────────────────

  /**
   * Send a structured agent-to-agent handoff.
   * AXL routes to the peer matching toPeerId.
   */
  async a2a(toPeerId: string, envelope: CapsuleEnvelope): Promise<void> {
    await this._post("/a2a/", {
      to:      toPeerId,
      message: JSON.stringify(envelope),
    });
  }

  // ── GossipSub (capsule.updated broadcast) ───────────────────────────────────

  readonly CAPSULE_TOPIC = "capsule.updated";

  async gossipSubscribe(topic = this.CAPSULE_TOPIC): Promise<void> {
    await this._post("/gossipsub/subscribe", { topic });
  }

  /**
   * Broadcast a capsule-updated announcement to the whole mesh.
   * Called automatically by broadcastCapsuleUpdated().
   */
  async gossipPublish(
    announce: CapsuleAnnounce,
    topic = this.CAPSULE_TOPIC
  ): Promise<void> {
    await this._post("/gossipsub/publish", {
      topic,
      payload: JSON.stringify(announce),
    });
  }

  async gossipMessages(topic = this.CAPSULE_TOPIC): Promise<GossipMessage[]> {
    const result = await this._get<{ messages: GossipMessage[] }>(
      `/gossipsub/messages?topic=${encodeURIComponent(topic)}`
    );
    return result.messages ?? [];
  }

  /**
   * Convenience: broadcast a capsule.updated announce after any capsule write.
   */
  async broadcastCapsuleUpdated(announce: CapsuleAnnounce): Promise<void> {
    try {
      await this.gossipPublish(announce);
    } catch (err) {
      // GossipSub is best-effort — don't fail the main flow if broadcast fails
      console.warn(`[axl] gossip broadcast failed (non-fatal): ${String(err)}`);
    }
  }

  // ── Decode helpers ──────────────────────────────────────────────────────────

  parseEnvelope(raw: AxlMessage): CapsuleEnvelope | null {
    try {
      return JSON.parse(raw.payload) as CapsuleEnvelope;
    } catch {
      return null;
    }
  }

  parseAnnounce(raw: GossipMessage): CapsuleAnnounce | null {
    try {
      return JSON.parse(raw.payload) as CapsuleAnnounce;
    } catch {
      return null;
    }
  }

  // ── Internal HTTP helpers ───────────────────────────────────────────────────

  private async _get<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.base}${path}`, {
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`AXL ${path} → HTTP ${res.status}: ${await res.text()}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async _post<T = unknown>(
    path: string,
    body: Record<string, unknown>
  ): Promise<T> {
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.base}${path}`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
        signal:  controller.signal,
      });
      if (!res.ok) {
        throw new Error(`AXL POST ${path} → HTTP ${res.status}: ${await res.text()}`);
      }
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createAxlClient(baseUrl: string, timeoutMs?: number): AxlClient {
  return new AxlClient({ baseUrl, timeoutMs });
}

/**
 * Build the AXL base URL from environment variables.
 * Reads AXL_API_PORT (set per-container) with fallback.
 */
export function axlUrlFromEnv(fallbackPort = 9101): string {
  const port = process.env["AXL_API_PORT"] ?? String(fallbackPort);
  return `http://127.0.0.1:${port}`;
}
