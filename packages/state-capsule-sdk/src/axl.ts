/**
 * axl.ts — Typed HTTP client for a local Gensyn AXL daemon.
 *
 * Actual AXL HTTP API (from source inspection):
 *
 *   GET  /topology              → TopologyInfo { our_public_key, peers, tree }
 *   POST /send                  → raw binary body, X-Destination-Peer-Id header
 *   GET  /recv                  → raw binary body + X-From-Peer-Id header (204 = empty)
 *   POST /a2a/{peer_id}         → JSON-RPC A2A envelope (peer_id in URL path)
 *   GET  /a2a/{peer_id}         → agent card discovery
 *   POST /mcp/{peer_id}         → MCP request forwarding
 *
 * There is no built-in GossipSub HTTP endpoint. The GossipSub broadcast
 * pattern is implemented via /send to all known peers (fan-out).
 *
 * Message format:
 *   We use a JSON CapsuleEnvelope encoded as UTF-8 bytes for /send and /recv.
 *   For /a2a/ we use the A2A JSON-RPC wrapper.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type MessageType =
  | "capsule.handoff"   // primary handoff: next agent should restore + continue
  | "capsule.updated"   // fan-out broadcast to all peers (gossip replacement)
  | "capsule.request"   // request latest capsule for a task
  | "capsule.response"; // response to a request

export interface CapsuleEnvelope {
  type:         MessageType;
  task_id:      string;
  capsule_id:   string;
  holder:       string;
  log_root?:    string | null;
  next_holder?: string;
  payload?:     Record<string, unknown>;
  sent_at:      string;
}

export interface AxlTopology {
  our_public_key: string;
  our_ipv6:       string;
  peers:          Array<{
    uri:        string;
    up:         boolean;
    public_key: string;
  }> | null;
  tree: Array<{
    public_key: string;
    parent:     string;
    sequence:   number;
  }>;
}

export interface AxlMessage {
  from:    string;   // X-From-Peer-Id header value
  data:    Uint8Array;
}

export interface CapsuleAnnounce {
  task_id:    string;
  capsule_id: string;
  holder:     string;
  log_root?:  string | null;
  timestamp:  string;
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface AxlClientConfig {
  baseUrl:    string;
  timeoutMs?: number;
}

// ── Client ────────────────────────────────────────────────────────────────────

export class AxlClient {
  private base:      string;
  private timeoutMs: number;

  constructor(config: AxlClientConfig) {
    this.base      = config.baseUrl.replace(/\/$/, "");
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  // ── Topology ────────────────────────────────────────────────────────────────

  async topology(): Promise<AxlTopology> {
    return this._getJson<AxlTopology>("/topology");
  }

  async ownPeerId(): Promise<string> {
    const topo = await this.topology();
    return topo.our_public_key;
  }

  /** Return all connected peer public keys */
  async connectedPeers(): Promise<string[]> {
    const topo = await this.topology();
    return (topo.peers ?? [])
      .filter((p) => p.up)
      .map((p) => p.public_key);
  }

  // ── /send (point-to-point raw binary) ──────────────────────────────────────

  /**
   * Send raw bytes to a peer. Uses X-Destination-Peer-Id header.
   */
  async send(toPeerId: string, data: Uint8Array): Promise<void> {
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.base}/send`, {
        method:  "POST",
        headers: { "X-Destination-Peer-Id": toPeerId },
        body:    data,
        signal:  controller.signal,
      });
      if (!res.ok) throw new Error(`AXL /send → HTTP ${res.status}: ${await res.text()}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Send a CapsuleEnvelope to a peer via /send.
   */
  async sendEnvelope(toPeerId: string, envelope: CapsuleEnvelope): Promise<void> {
    const data = new TextEncoder().encode(JSON.stringify(envelope));
    await this.send(toPeerId, data);
  }

  // ── /recv (poll inbox) ─────────────────────────────────────────────────────

  /**
   * Poll for one message from the inbox.
   * Returns null if inbox is empty (204).
   */
  async recvOne(): Promise<AxlMessage | null> {
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.base}/recv`, { signal: controller.signal });
      if (res.status === 204) return null;                 // empty inbox
      if (!res.ok) throw new Error(`AXL /recv → HTTP ${res.status}: ${await res.text()}`);

      const from = res.headers.get("X-From-Peer-Id") ?? "";
      const buf  = await res.arrayBuffer();
      return { from, data: new Uint8Array(buf) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Drain up to `max` messages from the inbox.
   */
  async recv(max = 10): Promise<AxlMessage[]> {
    const messages: AxlMessage[] = [];
    for (let i = 0; i < max; i++) {
      const msg = await this.recvOne();
      if (!msg) break;
      messages.push(msg);
    }
    return messages;
  }

  // ── /a2a/{peer_id} ─────────────────────────────────────────────────────────

  /**
   * Send a JSON-RPC A2A message to a peer.
   * The peer_id is embedded in the URL path.
   */
  async a2a(toPeerId: string, envelope: CapsuleEnvelope): Promise<unknown> {
    const body       = JSON.stringify(envelope);
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.base}/a2a/${toPeerId}`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal:  controller.signal,
      });
      if (!res.ok) throw new Error(`AXL /a2a → HTTP ${res.status}: ${await res.text()}`);
      const text = await res.text();
      return text ? JSON.parse(text) : {};
    } finally {
      clearTimeout(timer);
    }
  }

  // ── GossipSub replacement: fan-out via /send ──────────────────────────────

  /**
   * Broadcast a capsule.updated announce to all connected peers via /send fan-out.
   * Best-effort — failures are logged but do not throw.
   */
  async broadcastCapsuleUpdated(announce: CapsuleAnnounce): Promise<void> {
    const envelope: CapsuleEnvelope = {
      type:       "capsule.updated",
      task_id:    announce.task_id,
      capsule_id: announce.capsule_id,
      holder:     announce.holder,
      log_root:   announce.log_root,
      sent_at:    announce.timestamp,
    };
    const data = new TextEncoder().encode(JSON.stringify(envelope));

    let peers: string[];
    try {
      peers = await this.connectedPeers();
    } catch {
      return;
    }

    await Promise.allSettled(
      peers.map((peerId) =>
        this.send(peerId, data).catch((err) =>
          console.warn(`[axl] broadcast to ${peerId.slice(0, 16)}... failed: ${err}`)
        )
      )
    );
  }

  // ── Decode helpers ──────────────────────────────────────────────────────────

  parseEnvelope(msg: AxlMessage): CapsuleEnvelope | null {
    try {
      const text = new TextDecoder().decode(msg.data);
      return JSON.parse(text) as CapsuleEnvelope;
    } catch {
      return null;
    }
  }

  // ── Internal JSON GET ───────────────────────────────────────────────────────

  private async _getJson<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.base}${path}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`AXL ${path} → HTTP ${res.status}: ${await res.text()}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createAxlClient(baseUrl: string, timeoutMs?: number): AxlClient {
  return new AxlClient({
    baseUrl,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

export function axlUrlFromEnv(fallbackPort = 9101): string {
  const port = process.env["AXL_API_PORT"] ?? String(fallbackPort);
  return `http://127.0.0.1:${port}`;
}
