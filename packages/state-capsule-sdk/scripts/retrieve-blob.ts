#!/usr/bin/env tsx
/**
 * Quick proof-of-retrieval: fetch a capsule blob from 0G testnet by root hash
 * and decode it back to a Capsule object.
 *
 * Usage:
 *   ROOT_HASH=0xabc... pnpm --filter @state-capsule/sdk exec tsx scripts/retrieve-blob.ts
 */
import { Indexer } from "@0gfoundation/0g-ts-sdk";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Default: genesis capsule from the latest live demo run
const ROOT_HASH = process.env["ROOT_HASH"]
  ?? "0x782bd6259790d2916eb10eb27ab4f477fff9ae91e5c32bbc1a91ea9bd4fcb91c";
const INDEXER = process.env["OG_INDEXER_RPC"]
  ?? "https://indexer-storage-testnet-turbo.0g.ai";

console.log(`\n  Retrieving blob from 0G testnet`);
console.log(`  root hash : ${ROOT_HASH}`);
console.log(`  indexer   : ${INDEXER}\n`);

const indexer = new Indexer(INDEXER);
const dir     = await mkdtemp(join(tmpdir(), "sc-blob-"));
const outPath = join(dir, "blob.bin");

try {
  const dlErr = await indexer.download(ROOT_HASH, outPath, false);
  if (dlErr) throw new Error(`download error: ${dlErr}`);

  const bytes   = await readFile(outPath);
  const capsule = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;

  console.log("  ✓  Blob retrieved from 0G Storage\n");
  console.log(`  capsule_id  : ${capsule["capsule_id"]}`);
  console.log(`  task_id     : ${capsule["task_id"]}`);
  console.log(`  holder      : ${capsule["holder"]}`);
  console.log(`  next_action : ${capsule["next_action"]}`);
  console.log(`  goal        : ${capsule["goal"]}`);
  console.log(`  created_at  : ${capsule["created_at"]}`);
  console.log(`  schema_ver  : ${capsule["schema_version"]}`);
  console.log(`  facts       : ${(capsule["facts"] as unknown[])?.length ?? 0} entries`);
  console.log(`  raw bytes   : ${bytes.length}`);
  console.log(`  signature   : ${String(capsule["signature"]).slice(0, 32)}…`);
  console.log();
} finally {
  await rm(dir, { recursive: true, force: true });
}
