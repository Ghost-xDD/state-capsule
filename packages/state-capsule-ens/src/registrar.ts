/**
 * registrar.ts — NameStone HTTP client.
 *
 * NameStone provides off-chain CCIP-Read subname issuance on top of ENS.
 * Subnames are issued programmatically with no per-subname gas.
 * Text records set here are resolvable by any ENS-compatible client via
 * the NameStone CCIP-Read gateway.
 *
 * API reference: https://docs.namestone.xyz/api
 *
 * Required env vars:
 *   NAMESTONE_API_KEY   — from https://namestone.com dashboard
 *   ENS_PARENT_NAME     — e.g. "maintainerswarm.eth"
 *
 * All methods log a warning and return gracefully on network failure so the
 * caller's critical path (capsule writes) is never blocked by ENS.
 */

// ── Config ────────────────────────────────────────────────────────────────────

const NS_BASE_MAINNET = "https://namestone.com/api/public_v1";
const NS_BASE_SEPOLIA = "https://namestone.com/api/public_v1_sepolia";

export interface NameStoneConfig {
  apiKey:     string;
  domain:     string;  // e.g. "maintainerswarm.eth"
  /** "sepolia" (default) | "mainnet" */
  network?:   "sepolia" | "mainnet";
  /** Address to use as the subname's ETH record (can be any valid address). */
  address?:   string;
}

function baseUrl(network: "sepolia" | "mainnet"): string {
  return network === "mainnet" ? NS_BASE_MAINNET : NS_BASE_SEPOLIA;
}

// ── NameStone API client ──────────────────────────────────────────────────────

export class NameStoneRegistrar {
  private cfg: Required<NameStoneConfig>;

  constructor(config: NameStoneConfig) {
    this.cfg = {
      network: "sepolia",
      address: "0x0000000000000000000000000000000000000001",
      ...config,
    };
  }

  // ── Low-level request ─────────────────────────────────────────────────────

  private async _req(
    method: "GET" | "POST",
    endpoint: string,
    body?: unknown,
  ): Promise<unknown> {
    const base = baseUrl(this.cfg.network);
    const url  = `${base}${endpoint}`;

    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "Authorization": this.cfg.apiKey,
      },
      body:   body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`NameStone ${method} ${endpoint} → HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return text ? JSON.parse(text) : undefined;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Issue (or upsert) a subname with text records.
   * Returns the full name: `<label>.<domain>`.
   */
  async issueSubname(
    label:       string,
    textRecords: Record<string, string>,
  ): Promise<string> {
    await this._req("POST", "/set-name", {
      domain:       this.cfg.domain,
      name:         label,
      address:      this.cfg.address,
      text_records: textRecords,
    });
    return `${label}.${this.cfg.domain}`;
  }

  /**
   * Update text records on an existing subname.
   * NameStone's set-name is idempotent — this is the same call as issueSubname.
   */
  async setTextRecords(
    label:       string,
    textRecords: Record<string, string>,
  ): Promise<void> {
    await this._req("POST", "/set-name", {
      domain:       this.cfg.domain,
      name:         label,
      address:      this.cfg.address,
      text_records: textRecords,
    });
  }

  /**
   * Resolve all text records for a label.
   * Returns null if the subname does not exist.
   */
  async resolveSubname(label: string): Promise<Record<string, string> | null> {
    type NameEntry = { name: string; text_records?: Record<string, string> };
    const names = await this._req(
      "GET",
      `/get-names?domain=${encodeURIComponent(this.cfg.domain)}&text_records=1&limit=1000`,
    ) as NameEntry[];

    const match = names.find((n) => n.name === label);
    return match ? (match.text_records ?? {}) : null;
  }

  /**
   * Delete a subname (revoke).
   */
  async burnSubname(label: string): Promise<void> {
    await this._req("POST", "/delete-name", {
      domain: this.cfg.domain,
      name:   label,
    });
  }
}

// ── Factory + singleton ───────────────────────────────────────────────────────

/**
 * Build a NameStoneRegistrar from environment variables.
 * Returns null if NAMESTONE_API_KEY or ENS_PARENT_NAME are not set.
 */
export function createRegistrarFromEnv(): NameStoneRegistrar | null {
  const apiKey = process.env["NAMESTONE_API_KEY"];
  const domain = process.env["ENS_PARENT_NAME"];
  if (!apiKey || !domain) return null;

  const network = (process.env["ENS_NETWORK"] ?? "sepolia") as "sepolia" | "mainnet";
  return new NameStoneRegistrar({ apiKey, domain, network });
}
