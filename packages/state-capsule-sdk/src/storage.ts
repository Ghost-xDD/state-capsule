/**
 * storage.ts — StorageAdapter interface + ZeroGStorage implementation.
 *
 * Adapter interface is intentionally thin so other backends (in-memory,
 * S3, IPFS) can be swapped in for testing or alternative deployments.
 *
 * ZeroGStorage:
 *   - blobWrite / blobRead → 0G Storage Indexer (MemData upload, content-addressed)
 *   - kvSet / kvGet        → 0G Storage KV via Batcher (DL-001 fix applied)
 *
 * DL-001 fix: pass getFlowContract(addr, signer) to Batcher, NOT the raw address.
 */

import {
  Indexer,
  MemData,
  Batcher,
  KvClient,
  getFlowContract,
} from "@0gfoundation/0g-ts-sdk";
import { ethers } from "ethers";
import type { ZeroGConfig } from "./schema.js";

// ── Interface ─────────────────────────────────────────────────────────────────

export interface StorageAdapter {
  /**
   * Write arbitrary bytes to immutable blob storage.
   * Returns a content-addressed root hash that serves as the blob ID.
   */
  blobWrite(data: Uint8Array): Promise<string>;

  /**
   * Read a blob by root hash. Throws if not found.
   */
  blobRead(rootHash: string): Promise<Uint8Array>;

  /**
   * Write a key-value pair to mutable KV storage.
   * Returns the on-chain transaction hash.
   */
  kvSet(key: string, value: Uint8Array): Promise<string>;

  /**
   * Read a value by key. Returns null if not found.
   */
  kvGet(key: string): Promise<Uint8Array | null>;
}

// ── In-memory adapter (testing + offline) ────────────────────────────────────

export class MemoryStorage implements StorageAdapter {
  private blobs = new Map<string, Uint8Array>();
  private kv    = new Map<string, Uint8Array>();

  async blobWrite(data: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", data);
    const hash   = "0x" + Buffer.from(digest).toString("hex");
    this.blobs.set(hash, data);
    return hash;
  }

  async blobRead(rootHash: string): Promise<Uint8Array> {
    const data = this.blobs.get(rootHash);
    if (!data) throw new Error(`Blob not found: ${rootHash}`);
    return data;
  }

  async kvSet(key: string, value: Uint8Array): Promise<string> {
    this.kv.set(key, value);
    return "0x" + "00".repeat(32); // fake tx hash for in-memory
  }

  async kvGet(key: string): Promise<Uint8Array | null> {
    return this.kv.get(key) ?? null;
  }
}

// ── 0G Storage adapter ────────────────────────────────────────────────────────

export class ZeroGStorage implements StorageAdapter {
  private indexer:  Indexer;
  private kvClient: KvClient;
  private signer:   ethers.Wallet;
  private config:   ZeroGConfig;

  constructor(config: ZeroGConfig) {
    this.config   = config;
    this.indexer  = new Indexer(config.indexerRpc);
    this.kvClient = new KvClient(config.kvClientUrl);
    const provider = new ethers.JsonRpcProvider(config.evmRpc);
    this.signer    = new ethers.Wallet(config.privateKey, provider);
  }

  // ── Blob (Log primitive) ────────────────────────────────────────────────

  async blobWrite(data: Uint8Array): Promise<string> {
    const memData = new MemData(data);
    const [tree, treeErr] = await memData.merkleTree();
    if (treeErr || !tree) throw new Error(`merkleTree: ${treeErr}`);
    const rootHash = tree.rootHash();
    if (!rootHash) throw new Error("0G merkle tree returned null rootHash");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [, uploadErr] = await this.indexer.upload(memData, this.config.evmRpc, this.signer as any);
    if (uploadErr) throw new Error(`0G upload: ${uploadErr}`);

    return rootHash;
  }

  async blobRead(rootHash: string): Promise<Uint8Array> {
    // Use indexer.download to a temp path then read back
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const dir      = await mkdtemp(join(tmpdir(), "sc-blob-"));
    const outPath  = join(dir, "blob.bin");

    try {
      const dlErr = await this.indexer.download(rootHash, outPath, false);
      if (dlErr) throw new Error(`0G download: ${dlErr}`);
      return await readFile(outPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ── KV (mutable head) ───────────────────────────────────────────────────

  async kvSet(key: string, value: Uint8Array): Promise<string> {
    const [nodes, nodesErr] = await this.indexer.selectNodes(1);
    if (nodesErr) throw new Error(`selectNodes: ${nodesErr}`);

    // DL-001 fix: pass signer-connected Contract, not raw address string.
    // Cast signer to any to bridge ESM↔CJS ethers type boundary.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flowContract = getFlowContract(this.config.flowContract, this.signer as any);
    const batcher = new Batcher(1, nodes, flowContract, this.config.evmRpc);

    const keyBytes = new TextEncoder().encode(key);
    batcher.streamDataBuilder.set(this.config.kvStreamId, keyBytes, value);

    const [tx, batchErr] = await batcher.exec();
    if (batchErr) throw new Error(`KV write: ${batchErr}`);

    return (tx as { txHash: string }).txHash;
  }

  async kvGet(key: string): Promise<Uint8Array | null> {
    const keyBytes = new TextEncoder().encode(key);

    // SDK expects Bytes (Uint8Array) for the key; cast to any to bridge types
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await this.kvClient.getValue(
      this.config.kvStreamId,
      keyBytes as unknown as any
    ) as { data?: string; size?: number } | string | null;

    if (!result) return null;

    // SDK returns either a base64 string or { data, size } object
    const b64 = typeof result === "string"
      ? result
      : (result as { data?: string }).data;

    if (!b64 || b64 === "") return null;
    return Uint8Array.from(Buffer.from(b64, "base64"));
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createStorage(config: ZeroGConfig): StorageAdapter {
  return new ZeroGStorage(config);
}

export function createMemoryStorage(): StorageAdapter {
  return new MemoryStorage();
}
