/**
 * spike-0g-storage.ts
 *
 * De-risk: Confirm 0G Storage blob upload AND KV write work end-to-end.
 *
 * SDK bug workaround (DL-001):
 *   `new Batcher(1, nodes, FLOW_ADDRESS_STRING, rpc)` fails because Uploader
 *   calls `this.flow.market()` expecting an ethers Contract, not a plain string.
 *   Fix: pass `getFlowContract(address, signer)` as the third argument instead.
 *
 * Prerequisites:
 *   - OG_PRIVATE_KEY, OG_EVM_RPC, OG_INDEXER_RPC in .env
 *   - Wallet funded with testnet 0G tokens (https://faucet.0g.ai)
 *
 * Usage:
 *   tsx scripts/spikes/spike-0g-storage.ts
 */

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(import.meta.dirname, "../../.env"), override: true });

import { Indexer, MemData, Batcher, KvClient, getFlowContract } from "@0gfoundation/0g-ts-sdk";
import { ethers } from "ethers";

// ── Config ──────────────────────────────────────────────────────────────────

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`[spike-0g-storage] FAIL: missing env var ${key}`);
    process.exit(1);
  }
  return v;
}

const PRIVATE_KEY     = requireEnv("OG_PRIVATE_KEY");
const EVM_RPC         = process.env["OG_EVM_RPC"]         ?? "https://evmrpc-testnet.0g.ai";
const INDEXER_RPC     = process.env["OG_INDEXER_RPC"]     ?? "https://indexer-storage-testnet-turbo.0g.ai";
const FLOW_CONTRACT   = process.env["OG_FLOW_CONTRACT"]   ?? "0x22E03a6A89B950F1c82ec5e74F8eCa321a105296";
const KV_URL          = process.env["OG_KV_CLIENT_URL"]   ?? "http://178.238.236.119:6789";

// Deterministic stream ID for state-capsule spike data
const STREAM_ID = "0x" + "ab12".repeat(16);

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(msg: string) { console.log(`[spike-0g-storage] ${msg}`); }

function fail(msg: string): never {
  console.error(`[spike-0g-storage] FAIL: ${msg}`);
  process.exit(1);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const signer   = new ethers.Wallet(PRIVATE_KEY, provider);
  const address  = await signer.getAddress();
  log(`Wallet      : ${address}`);
  log(`EVM RPC     : ${EVM_RPC}`);
  log(`Indexer RPC : ${INDEXER_RPC}`);

  const indexer = new Indexer(INDEXER_RPC);

  // ── Part 1: Root hash determinism (no network) ──────────────────────────

  log("─── Part 1: Root hash (determinism check) ────────────────");

  const capsulePayload = JSON.stringify({
    capsule_id: "spike-capsule-v1",
    task_id: "spike-task-fixed",
    schema_version: "0.1.0",
    goal: "Spike: prove storage works",
    holder: "triager",
    created_at: "2026-04-28T00:00:00.000Z",
  });

  const [tree1] = await new MemData(new TextEncoder().encode(capsulePayload)).merkleTree();
  const [tree2] = await new MemData(new TextEncoder().encode(capsulePayload)).merkleTree();
  const rootHash1 = tree1?.rootHash();
  const rootHash2 = tree2?.rootHash();

  if (rootHash1 !== rootHash2) fail("root hash is not deterministic!");
  log(`Root hash: ${rootHash1}`);
  log("Root hash determinism ✅");

  // ── Part 2: Blob upload via Indexer ────────────────────────────────────

  log("─── Part 2: Blob upload ───────────────────────────────────");

  const logEntry = JSON.stringify({
    seq: 0,
    task_id: "spike-task-fixed",
    event: "capsule_created",
    holder: "triager",
    timestamp: new Date().toISOString(),
  });

  const uploadData = new TextEncoder().encode(logEntry);
  const memData    = new MemData(uploadData);
  const [blobTree] = await memData.merkleTree();
  const blobRoot   = blobTree?.rootHash();
  log(`Blob root hash : ${blobRoot}`);
  log("Uploading blob (may take 10-30s)...");

  const t0 = Date.now();
  const [tx, uploadErr] = await indexer.upload(memData, EVM_RPC, signer);
  if (uploadErr) fail(`upload: ${uploadErr}`);
  const blobElapsed = Date.now() - t0;
  const blobTxHash = tx && "txHash" in tx ? tx.txHash : "(fragmented)";
  log(`Blob upload ok (${blobElapsed}ms) tx: ${blobTxHash} ✅`);

  // ── Part 3: KV write via Batcher (fixed) ───────────────────────────────

  log("─── Part 3: KV write (Batcher + getFlowContract fix) ─────");
  log("Workaround: pass getFlowContract(addr, signer) instead of raw address");

  // Fix: construct the flow contract with a signer before passing to Batcher
  const flowContract = getFlowContract(FLOW_CONTRACT, signer);
  log(`flow.market callable: ${typeof flowContract.market === "function" ? "yes ✅" : "no ❌"}`);

  const [nodes, nodesErr] = await indexer.selectNodes(1);
  if (nodesErr) fail(`selectNodes: ${nodesErr}`);

  const batcher = new Batcher(1, nodes, flowContract, EVM_RPC);

  const taskId  = `kv-spike-${Date.now()}`;
  const keyBytes = Uint8Array.from(Buffer.from(taskId, "utf-8"));
  const valBytes = Uint8Array.from(Buffer.from(JSON.stringify({
    capsule_id: `capsule-${Date.now()}`,
    task_id: taskId,
    holder: "triager",
    ts: new Date().toISOString(),
  }), "utf-8"));

  batcher.streamDataBuilder.set(STREAM_ID, keyBytes, valBytes);

  log(`KV stream ID : ${STREAM_ID}`);
  log(`KV key       : ${taskId}`);
  log("Calling batcher.exec() (may take 10-30s)...");

  const t1 = Date.now();
  const [kvTx, kvErr] = await batcher.exec();
  if (kvErr) fail(`batcher.exec: ${kvErr}`);
  const kvElapsed = Date.now() - t1;
  log(`KV write ok (${kvElapsed}ms) tx: ${(kvTx as any).txHash} ✅`);

  // ── Summary ──────────────────────────────────────────────────────────────

  console.log(`
✅  0G Storage spike PASSED

  Wallet        : ${address}
  Blob root hash: ${blobRoot}
  Blob upload tx: ${blobTxHash} (${blobElapsed}ms)
  KV write tx   : ${(kvTx as any).txHash} (${kvElapsed}ms)
  KV stream ID  : ${STREAM_ID}
  KV key        : ${taskId}

  Proven:
    ✅  MemData blob upload works (flow contract auto-discovered by Indexer)
    ✅  Root hash is deterministic — same payload → same hash
    ✅  KV Batcher works with getFlowContract(addr, signer) fix
    ✅  Both primitives confirmed on Galileo testnet

  SDK bug (DL-001 resolved):
    Batcher 3rd arg must be getFlowContract(addr, signer), NOT a raw address string.
    The Uploader expects an ethers Contract object to call flow.market().
    Fix is one line — no SDK patch needed.
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
