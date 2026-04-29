/**
 * axl.ts — Typed HTTP client for a local Gensyn AXL daemon, plus a TypeScript
 * GossipSub implementation protocol-compatible with the Python reference:
 * https://github.com/gensyn-ai/axl/blob/main/examples/python-client/gossipsub/gossipsub.py
 *
 * Transport layer (AXL HTTP API):
 *   GET  /topology              → TopologyInfo
 *   POST /send                  → raw binary body + X-Destination-Peer-Id header
 *   GET  /recv                  → raw binary body + X-From-Peer-Id header (204 = empty)
 *   POST /a2a/{peer_id}         → A2A JSON-RPC envelope
 *
 * GossipSub runs on top of /send + /recv using a JSON message envelope
 * (type: "gossipsub") that is interoperable with the Python implementation.
 * Point-to-point capsule handoffs use /a2a/ directly.
 */

// ── Capsule message types ─────────────────────────────────────────────────────

export type MessageType =
  | "capsule.handoff"   // primary a2a handoff
  | "capsule.updated"   // gossipsub broadcast topic
  | "capsule.request"
  | "capsule.response";

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

export interface CapsuleAnnounce {
  task_id:    string;
  capsule_id: string;
  holder:     string;
  log_root?:  string | null;
  timestamp:  string;
}

// ── AXL topology types ────────────────────────────────────────────────────────

export interface AxlTopology {
  our_public_key: string;
  our_ipv6:       string;
  peers:          Array<{ uri: string; up: boolean; public_key: string }> | null;
  tree:           Array<{ public_key: string; parent: string; sequence: number }>;
}

export interface AxlMessage {
  from: string;         // X-From-Peer-Id
  data: Uint8Array;
}

// ── GossipSub message types (wire format — matches Python impl) ───────────────

type GossipMsgType = "MESSAGE" | "GRAFT" | "PRUNE" | "IHAVE" | "IWANT";

interface GossipFrame {
  type:     "gossipsub";
  msg_type: GossipMsgType;
  topic?:   string;
  msg_id?:  string;
  msg_ids?: string[];
  origin?:  string;
  from?:    string;
  hop?:     number;
  data?:    string;   // base64-encoded payload
  peers?:   string[];
}

interface GossipConfig {
  D:                 number;   // target mesh degree
  D_low:             number;
  D_high:            number;
  D_gossip:          number;
  heartbeat_interval: number; // seconds
  max_ihave_length:  number;
}

const DEFAULT_GOSSIP_CONFIG: GossipConfig = {
  D:                  3,
  D_low:              2,
  D_high:             4,
  D_gossip:           1,
  heartbeat_interval: 1.0,
  max_ihave_length:   5000,
};

// ── AXL HTTP client ───────────────────────────────────────────────────────────

export interface AxlClientConfig {
  baseUrl:    string;
  timeoutMs?: number;
}

export class AxlClient {
  private base:      string;
  private timeoutMs: number;

  constructor(config: AxlClientConfig) {
    this.base      = config.baseUrl.replace(/\/$/, "");
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async topology(): Promise<AxlTopology> {
    return this._getJson<AxlTopology>("/topology");
  }

  async ownPeerId(): Promise<string> {
    return (await this.topology()).our_public_key;
  }

  async connectedPeers(): Promise<string[]> {
    const topo = await this.topology();
    return (topo.peers ?? []).filter((p) => p.up).map((p) => p.public_key);
  }

  // ── /send ──────────────────────────────────────────────────────────────────

  async send(toPeerId: string, data: Uint8Array): Promise<void> {
    await this._raw("POST", "/send", data, { "X-Destination-Peer-Id": toPeerId });
  }

  async sendEnvelope(toPeerId: string, envelope: CapsuleEnvelope): Promise<void> {
    await this.send(toPeerId, new TextEncoder().encode(JSON.stringify(envelope)));
  }

  // ── /recv ──────────────────────────────────────────────────────────────────

  async recvOne(): Promise<AxlMessage | null> {
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.base}/recv`, { signal: controller.signal });
      if (res.status === 204) return null;
      if (!res.ok) throw new Error(`AXL /recv → HTTP ${res.status}: ${await res.text()}`);
      const from = res.headers.get("X-From-Peer-Id") ?? "";
      const buf  = await res.arrayBuffer();
      return { from, data: new Uint8Array(buf) };
    } finally {
      clearTimeout(timer);
    }
  }

  async recv(max = 10): Promise<AxlMessage[]> {
    const out: AxlMessage[] = [];
    for (let i = 0; i < max; i++) {
      const m = await this.recvOne();
      if (!m) break;
      out.push(m);
    }
    return out;
  }

  // ── /a2a/{peer_id} ─────────────────────────────────────────────────────────

  async a2a(toPeerId: string, envelope: CapsuleEnvelope): Promise<unknown> {
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.base}/a2a/${toPeerId}`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(envelope),
        signal:  controller.signal,
      });
      if (!res.ok) throw new Error(`AXL /a2a → HTTP ${res.status}: ${await res.text()}`);
      const text = await res.text();
      return text ? JSON.parse(text) : {};
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Decode ─────────────────────────────────────────────────────────────────

  parseEnvelope(msg: AxlMessage): CapsuleEnvelope | null {
    try {
      return JSON.parse(new TextDecoder().decode(msg.data)) as CapsuleEnvelope;
    } catch { return null; }
  }

  parseGossipFrame(msg: AxlMessage): GossipFrame | null {
    try {
      const f = JSON.parse(new TextDecoder().decode(msg.data)) as GossipFrame;
      return f.type === "gossipsub" ? f : null;
    } catch { return null; }
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private async _raw(
    method: string, path: string,
    body?: Uint8Array | string,
    headers?: Record<string, string>
  ): Promise<string> {
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.base}${path}`, {
        method,
        ...(headers ? { headers } : {}),
        ...(body !== undefined ? { body } : {}),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`AXL ${method} ${path} → HTTP ${res.status}: ${await res.text()}`);
      return await res.text();
    } finally { clearTimeout(timer); }
  }

  private async _getJson<T>(path: string): Promise<T> {
    const text = await this._raw("GET", path);
    return JSON.parse(text) as T;
  }
}

// ── GossipSub (TypeScript port of the Python reference implementation) ────────

export class GossipSub {
  private config:    GossipConfig;
  private nodeId:    string;
  private transport: AxlClient;

  private peers           = new Set<string>();
  private mesh            = new Map<string, Set<string>>();  // topic → peer set
  private subscriptions   = new Set<string>();
  private seenMsgs        = new Set<string>();
  private msgCache        = new Map<string, GossipFrame>();
  private pendingIwant    = new Set<string>();
  private msgCounter      = 0;
  private lastHeartbeat   = Date.now();

  private applicationHandlers = new Map<string, (data: Uint8Array, from: string) => void>();

  constructor(nodeId: string, transport: AxlClient, config?: Partial<GossipConfig>) {
    this.nodeId    = nodeId;
    this.transport = transport;
    this.config    = { ...DEFAULT_GOSSIP_CONFIG, ...config };
  }

  addPeer(peerId: string): void { this.peers.add(peerId); }
  removePeer(peerId: string): void { this.peers.delete(peerId); }

  subscribe(topic: string, handler?: (data: Uint8Array, from: string) => void): void {
    this.subscriptions.add(topic);
    if (!this.mesh.has(topic)) this.mesh.set(topic, new Set());
    if (handler) this.applicationHandlers.set(topic, handler);
  }

  async publish(topic: string, data: Uint8Array): Promise<string> {
    const msgId = this._genMsgId();
    this.seenMsgs.add(msgId);

    const frame: GossipFrame = {
      type:     "gossipsub",
      msg_type: "MESSAGE",
      topic,
      msg_id:   msgId,
      origin:   this.nodeId,
      from:     this.nodeId,
      hop:      0,
      data:     Buffer.from(data).toString("base64"),
    };
    this.msgCache.set(msgId, frame);

    const targets = this.mesh.get(topic) ?? this.peers;
    await Promise.allSettled(
      [...targets].map((p) => this._sendFrame(p, frame))
    );

    return msgId;
  }

  /**
   * Process a single raw message from /recv. Call this from the main poll
   * loop after draining the queue — the runtime owns recv(), not GossipSub.
   * Returns true if the message was a gossipsub frame and was consumed.
   */
  async ingest(from: string, data: Uint8Array): Promise<boolean> {
    let frame: GossipFrame | null = null;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(data)) as GossipFrame;
      if (parsed.type === "gossipsub") frame = parsed;
    } catch { /* not JSON or not gossipsub */ }

    if (!frame) return false;
    await this._handleFrame(from, frame);
    return true;
  }

  /**
   * Run the heartbeat (mesh maintenance + IHAVE gossip). Call once per poll
   * iteration. Does NOT drain /recv.
   */
  async runHeartbeat(): Promise<void> {
    const now = Date.now();
    if ((now - this.lastHeartbeat) / 1000 >= this.config.heartbeat_interval) {
      await this._heartbeat();
      this.lastHeartbeat = now;
    }
  }

  /** @deprecated Use ingest() + runHeartbeat() from the runtime poll loop. */
  async tick(): Promise<void> {
    const messages = await this.transport.recv(20);
    for (const msg of messages) await this.ingest(msg.from, msg.data);
    await this.runHeartbeat();
  }

  // ── Frame dispatch ─────────────────────────────────────────────────────────

  private async _handleFrame(from: string, frame: GossipFrame): Promise<void> {
    switch (frame.msg_type) {
      case "MESSAGE": return this._handleMessage(from, frame);
      case "GRAFT":   return this._handleGraft(from, frame);
      case "PRUNE":   return this._handlePrune(from, frame);
      case "IHAVE":   return this._handleIhave(from, frame);
      case "IWANT":   return this._handleIwant(from, frame);
    }
  }

  private async _handleMessage(from: string, frame: GossipFrame): Promise<void> {
    const msgId = frame.msg_id ?? "";
    const topic = frame.topic ?? "";
    const hop   = frame.hop ?? 0;

    if (this.seenMsgs.has(msgId)) return;
    this.seenMsgs.add(msgId);
    this.msgCache.set(msgId, frame);

    if (!this.subscriptions.has(topic)) return;

    // Deliver to application handler
    const handler = this.applicationHandlers.get(topic);
    if (handler && frame.data) {
      const data = Buffer.from(frame.data, "base64");
      try { handler(data, from); } catch { /* best-effort */ }
    }

    // Lazy-first forwarding: eager push to 1 mesh peer, IHAVE to the rest
    const origin     = frame.origin ?? "";
    const candidates = [...(this.mesh.get(topic) ?? new Set())]
      .filter((p) => p !== from && p !== origin);

    const fwd: GossipFrame = { ...frame, hop: hop + 1, from: this.nodeId };

    if (candidates[0]) await this._sendFrame(candidates[0], fwd);
    if (candidates.length > 1) {
      await this._sendIhave(candidates.slice(1), topic, [msgId]);
    }
  }

  private async _handleGraft(from: string, frame: GossipFrame): Promise<void> {
    const topic = frame.topic ?? "";
    if (!this.subscriptions.has(topic)) return;
    const mesh = this.mesh.get(topic) ?? new Set<string>();
    if (mesh.size < this.config.D_high) {
      mesh.add(from);
      this.mesh.set(topic, mesh);
    } else {
      await this._sendFrame(from, { type: "gossipsub", msg_type: "PRUNE", topic, peers: [] });
    }
  }

  private _handlePrune(from: string, frame: GossipFrame): void {
    this.mesh.get(frame.topic ?? "")?.delete(from);
  }

  private async _handleIhave(from: string, frame: GossipFrame): Promise<void> {
    const topic  = frame.topic ?? "";
    if (!this.subscriptions.has(topic)) return;
    const wanted = (frame.msg_ids ?? []).filter(
      (id) => !this.seenMsgs.has(id) && !this.pendingIwant.has(id)
    );
    if (wanted.length > 0) {
      wanted.forEach((id) => this.pendingIwant.add(id));
      await this._sendFrame(from, { type: "gossipsub", msg_type: "IWANT", msg_ids: wanted.slice(0, 64) });
    }
  }

  private async _handleIwant(_from: string, frame: GossipFrame): Promise<void> {
    for (const id of frame.msg_ids ?? []) {
      const cached = this.msgCache.get(id);
      if (cached) await this._sendFrame(_from, { ...cached, from: this.nodeId });
    }
  }

  // ── Heartbeat ──────────────────────────────────────────────────────────────

  private async _heartbeat(): Promise<void> {
    for (const topic of this.subscriptions) {
      await this._maintainMesh(topic);
      await this._emitGossip(topic);
    }
  }

  private async _maintainMesh(topic: string): Promise<void> {
    const mesh = this.mesh.get(topic) ?? new Set<string>();
    // Remove disappeared peers
    for (const p of mesh) { if (!this.peers.has(p)) mesh.delete(p); }

    if (mesh.size < this.config.D_low) {
      const candidates = shuffle([...this.peers].filter((p) => !mesh.has(p)));
      for (const peer of candidates.slice(0, this.config.D - mesh.size)) {
        mesh.add(peer);
        await this._sendFrame(peer, { type: "gossipsub", msg_type: "GRAFT", topic });
      }
    } else if (mesh.size > this.config.D_high) {
      const excess = shuffle([...mesh]).slice(0, mesh.size - this.config.D);
      for (const peer of excess) {
        mesh.delete(peer);
        await this._sendFrame(peer, { type: "gossipsub", msg_type: "PRUNE", topic, peers: [] });
      }
    }

    this.mesh.set(topic, mesh);
  }

  private async _emitGossip(topic: string): Promise<void> {
    const recent   = [...this.seenMsgs].slice(-this.config.max_ihave_length);
    if (!recent.length) return;
    const nonMesh  = [...this.peers].filter((p) => !(this.mesh.get(topic)?.has(p)));
    const num      = Math.min(this.config.D_gossip, nonMesh.length);
    for (const peer of shuffle(nonMesh).slice(0, num)) {
      await this._sendFrame(peer, { type: "gossipsub", msg_type: "IHAVE", topic, msg_ids: recent });
    }
  }

  private async _sendIhave(peers: string[], topic: string, msgIds: string[]): Promise<void> {
    await Promise.allSettled(
      peers.map((p) => this._sendFrame(p, { type: "gossipsub", msg_type: "IHAVE", topic, msg_ids: msgIds }))
    );
  }

  private async _sendFrame(peerId: string, frame: GossipFrame): Promise<void> {
    try {
      await this.transport.send(peerId, new TextEncoder().encode(JSON.stringify(frame)));
    } catch { /* best-effort */ }
  }

  private _genMsgId(): string {
    return `${this.nodeId.slice(0, 8)}:${String(++this.msgCounter).padStart(6, "0")}`;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createAxlClient(baseUrl: string, timeoutMs?: number): AxlClient {
  return new AxlClient({ baseUrl, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
}

export function axlUrlFromEnv(fallbackPort = 9101): string {
  const port = process.env["AXL_API_PORT"] ?? String(fallbackPort);
  return `http://127.0.0.1:${port}`;
}
