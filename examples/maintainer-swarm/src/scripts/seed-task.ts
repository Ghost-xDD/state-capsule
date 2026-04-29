/**
 * seed-task.ts — Inject an initial capsule into the swarm to kick off a run.
 *
 * Usage (from repo root):
 *   node examples/maintainer-swarm/dist/scripts/seed-task.js
 *
 * The script:
 *   1. Creates a genesis capsule
 *   2. Sends a capsule.handoff envelope to the triager via /send (AXL Pattern 1)
 *
 * Required env vars:
 *   TRIAGER_PEER_ID   — 64-char hex public key from /topology
 *   TRIAGER_AXL_URL   — default http://127.0.0.1:9101
 */

import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../../.env"), override: true });

import { StateCapsule, createMemoryStorage } from "@state-capsule/sdk";
import { AxlClient, type CapsuleEnvelope } from "@state-capsule/sdk";

async function main() {
  const triagerUrl    = process.env["TRIAGER_AXL_URL"]    ?? "http://127.0.0.1:9101";
  const triagerPeerId = process.env["TRIAGER_PEER_ID"];

  if (!triagerPeerId) {
    console.error(
      "TRIAGER_PEER_ID is required.\n" +
      "Hint: docker exec mswarm-triager wget -qO- http://127.0.0.1:9101/topology | " +
      "grep -o '\"our_public_key\":\"[^\"]*\"'"
    );
    process.exit(1);
  }

  const taskId = `bug-${Date.now()}`;
  console.log(`[seed] Creating task: ${taskId}`);

  const storage = createMemoryStorage();
  const sdk     = new StateCapsule({ storageAdapter: storage });

  const capsule = await sdk.createCapsule({
    task_id:         taskId,
    goal:            "Fix async race condition in queue.js — failing test: queue.test.js:42",
    holder:          "seed",
    facts:           [
      "Issue: queue.test.js:42 fails ~50% of the time",
      "Suspected cause: race between enqueue and dequeue",
    ],
    constraints:     ["do not break the public API", "must pass all existing tests"],
    pending_actions: ["reproduce", "patch", "review"],
    next_action:     "reproduce",
  });

  console.log(`[seed] Genesis capsule: ${capsule.capsule_id.slice(0, 16)}...`);

  const axl = new AxlClient({ baseUrl: triagerUrl });

  // Embed the full capsule payload so the triager can bootstrap its storage
  // without needing shared 0G storage for the genesis record.
  const envelope: CapsuleEnvelope = {
    type:        "capsule.handoff",
    task_id:     capsule.task_id,
    capsule_id:  capsule.capsule_id,
    holder:      "seed",
    next_holder: "triager",
    log_root:    capsule.log_root,
    payload:     { capsule },   // full genesis capsule for bootstrap
    sent_at:     new Date().toISOString(),
  };

  // Send via /send (AXL Pattern 1 — no A2A server required)
  await axl.sendEnvelope(triagerPeerId, envelope);
  console.log(`[seed] Handoff sent to triager (${triagerPeerId.slice(0, 16)}...)`);
  console.log(`[seed] Task ${taskId} is live — watch capsule.updated GossipSub topic`);
}

main().catch((err) => {
  console.error("[seed] Fatal:", err);
  process.exit(1);
});
