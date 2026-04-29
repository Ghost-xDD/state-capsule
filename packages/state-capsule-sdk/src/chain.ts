/**
 * chain.ts — viem client for CapsuleRegistry on-chain anchor.
 *
 * Used by updateCapsule to anchor each capsule write on 0G Chain.
 * On StaleParent revert the SDK rebases once and retries.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type Hash,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

// ── ABI (minimal — only what we call) ────────────────────────────────────────

export const CAPSULE_REGISTRY_ABI = [
  {
    type: "function",
    name: "anchor",
    inputs: [
      { name: "taskId",          type: "bytes32" },
      { name: "parentCapsuleId", type: "bytes32" },
      { name: "newCapsuleId",    type: "bytes32" },
      { name: "logRoot",         type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "head",
    inputs: [{ name: "taskId", type: "bytes32" }],
    outputs: [
      { name: "capsuleId", type: "bytes32" },
      { name: "logRoot",   type: "bytes32" },
    ],
    stateMutability: "view",
  },
  {
    type: "error",
    name: "StaleParent",
    inputs: [
      { name: "taskId",   type: "bytes32" },
      { name: "expected", type: "bytes32" },
      { name: "got",      type: "bytes32" },
    ],
  },
  {
    type: "error",
    name: "ZeroCapsuleId",
    inputs: [],
  },
  {
    type: "error",
    name: "ZeroTaskId",
    inputs: [],
  },
  {
    type: "event",
    name: "CapsuleAnchored",
    inputs: [
      { name: "taskId",          type: "bytes32", indexed: true  },
      { name: "capsuleId",       type: "bytes32", indexed: true  },
      { name: "parentCapsuleId", type: "bytes32", indexed: true  },
      { name: "logRoot",         type: "bytes32", indexed: false },
      { name: "sender",          type: "address", indexed: false },
      { name: "timestamp",       type: "uint256", indexed: false },
    ],
  },
] as const;

// ── 0G Chain definition ───────────────────────────────────────────────────────

const zeroGGalileo: Chain = {
  id:   16600,
  name: "0G Galileo Testnet",
  nativeCurrency: { name: "A0GI", symbol: "A0GI", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://evmrpc-testnet.0g.ai"] },
  },
};

// ── Config ────────────────────────────────────────────────────────────────────

export interface ChainConfig {
  privateKey:       string;   // 0x-prefixed
  rpcUrl?:          string;
  registryAddress?: string;   // falls back to deployments.json
}

// ── Client ────────────────────────────────────────────────────────────────────

export class ChainAnchor {
  private walletClient;
  private publicClient;
  private address: Hex;

  constructor(config: ChainConfig) {
    const chain = {
      ...zeroGGalileo,
      rpcUrls: {
        default: {
          http: [config.rpcUrl ?? "https://evmrpc-testnet.0g.ai"],
        },
      },
    };

    const account = privateKeyToAccount(config.privateKey as Hex);

    this.walletClient = createWalletClient({
      account,
      chain,
      transport: http(),
    });

    this.publicClient = createPublicClient({
      chain,
      transport: http(),
    });

    const addr = config.registryAddress ?? loadDeployedAddress("zerog");
    if (!addr) {
      throw new Error(
        "CapsuleRegistry address not provided and not found in deployments.json. " +
        "Run: pnpm --filter @state-capsule/contracts deploy:testnet"
      );
    }
    this.address = addr as Hex;
  }

  /**
   * Anchor a capsule update on-chain.
   * Returns the transaction hash.
   * Throws StaleParentError if the parent check fails.
   */
  async anchor(
    taskId:          string,
    parentCapsuleId: string,
    newCapsuleId:    string,
    logRoot:         string,
  ): Promise<Hash> {
    const hash = await this.walletClient.writeContract({
      address: this.address,
      abi:     CAPSULE_REGISTRY_ABI,
      functionName: "anchor",
      args: [
        taskId          as Hex,
        parentCapsuleId as Hex,
        newCapsuleId    as Hex,
        logRoot         as Hex,
      ],
    });

    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  /**
   * Read the current on-chain head for a task.
   */
  async head(taskId: string): Promise<{ capsuleId: string; logRoot: string }> {
    const [capsuleId, logRoot] = await this.publicClient.readContract({
      address: this.address,
      abi:     CAPSULE_REGISTRY_ABI,
      functionName: "head",
      args: [taskId as Hex],
    });
    return { capsuleId, logRoot };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Convert a task_id string to bytes32 (keccak256 hash).
 * This is the canonical task identifier used on-chain.
 */
export function taskIdToBytes32(taskId: string): Hex {
  // Inline keccak256 via viem
  const { keccak256, toHex, toBytes } = require("viem") as typeof import("viem");
  return keccak256(toHex(toBytes(taskId)));
}

/**
 * Load deployed registry address from SDK deployments.json.
 */
function loadDeployedAddress(network: string): string | undefined {
  try {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { resolve }      = require("node:path") as typeof import("node:path");
    const { fileURLToPath } = require("node:url") as typeof import("node:url");

    const dir  = resolve(fileURLToPath(import.meta.url), "../../..");
    const data = JSON.parse(
      readFileSync(resolve(dir, "deployments.json"), "utf-8")
    ) as Record<string, Record<string, string>>;
    return data[network]?.["CapsuleRegistry"];
  } catch {
    return undefined;
  }
}

// ── Stale parent error ────────────────────────────────────────────────────────

export class StaleParentError extends Error {
  constructor(
    public readonly taskId:   string,
    public readonly expected: string,
    public readonly got:      string,
  ) {
    super(
      `StaleParent: task ${taskId} — expected parent ${expected}, got ${got}. ` +
      `Another writer has advanced the chain. Rebase and retry.`
    );
    this.name = "StaleParentError";
  }
}

/**
 * Detect whether a viem contract call error is a StaleParent revert.
 */
export function isStaleParentError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.message.includes("StaleParent") ||
    (err as { cause?: { data?: string } }).cause?.data?.startsWith(
      // StaleParent(bytes32,bytes32,bytes32) selector
      "0x" + Buffer.from("StaleParent(bytes32,bytes32,bytes32)").toString("hex").slice(0, 8)
    ) === true
  );
}
