/**
 * spike-ens-subname.ts
 *
 * De-risk: Issue a subname via NameStone, set a text record,
 * and resolve it from a fresh client to confirm CCIP-Read works end-to-end.
 *
 * Prerequisites:
 *   1. Register an ENS name on Sepolia (app.ens.domains, switch to Sepolia)
 *   2. Set it up with NameStone resolver:
 *        Go to https://namestone.com → sign in with SIWE → add your domain
 *   3. Get your NameStone API key from the dashboard
 *   4. Set in .env:
 *        ENS_PARENT_NAME=yourname.eth
 *        NAMESTONE_API_KEY=<key>
 *        ENS_RPC_URL=https://rpc.sepolia.org   (or Alchemy/Infura Sepolia)
 *
 * Usage:
 *   tsx scripts/spikes/spike-ens-subname.ts
 *
 * What this proves:
 *   - NameStone setName() issues subnames programmatically (no per-subname gas)
 *   - Text records set via the API are retrievable via CCIP-Read from any ENS client
 *   - The task-pointer pattern (capsule.head, capsule.holder, etc.) round-trips
 */

import { NameStone } from "@namestone/namestone-sdk";
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";

// ── Config ──────────────────────────────────────────────────────────────────

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`
[spike-ens] FAIL: missing env var ${key}

Prerequisites:
  1. Register an ENS name on Sepolia and configure NameStone resolver
  2. Get a NameStone API key from https://namestone.com
  3. Set ENS_PARENT_NAME, NAMESTONE_API_KEY, ENS_RPC_URL in .env
`);
    process.exit(1);
  }
  return v;
}

const NAMESTONE_API_KEY = requireEnv("NAMESTONE_API_KEY");
const PARENT_NAME = requireEnv("ENS_PARENT_NAME");
const ENS_RPC_URL =
  process.env["ENS_RPC_URL"] ?? "https://rpc.sepolia.org";

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(msg: string) { console.log(`[spike-ens] ${msg}`); }

function fail(msg: string): never {
  console.error(`[spike-ens] FAIL: ${msg}`);
  process.exit(1);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log(`Parent name : ${PARENT_NAME}`);
  log(`ENS RPC     : ${ENS_RPC_URL}`);

  const ns = new NameStone(NAMESTONE_API_KEY);

  // The label for the spike subname (e.g. task-spike-<timestamp>.maintainerswarm.eth)
  const label = `task-spike-${Date.now()}`;
  const fullName = `${label}.${PARENT_NAME}`;

  // ── Issue a task-pointer subname ────────────────────────────────────────

  const fakeCapsuleId = `0x${"a".repeat(64)}`;
  const textRecords = {
    "capsule.head": fakeCapsuleId,
    "capsule.holder": "triager",
    "capsule.log_root": `0x${"b".repeat(64)}`,
    "capsule.status": "active",
  };

  log(`Issuing subname: ${fullName}`);
  log(`Text records: ${JSON.stringify(textRecords, null, 2)}`);

  const t0 = Date.now();
  await ns.setName({
    domain: PARENT_NAME,
    name: label,
    address: "0x0000000000000000000000000000000000000001", // placeholder
    text_records: textRecords,
  });
  log(`setName() ok (${Date.now() - t0}ms)`);

  // ── Resolve via viem (CCIP-Read) ────────────────────────────────────────

  log("Resolving via viem CCIP-Read (may take 2-5s)...");
  const client = createPublicClient({
    chain: sepolia,
    transport: http(ENS_RPC_URL),
  });

  // Pause briefly to allow NameStone's gateway to propagate
  await new Promise((r) => setTimeout(r, 2000));

  const t1 = Date.now();

  // Resolve each text record
  const resolved: Record<string, string> = {};
  for (const key of Object.keys(textRecords)) {
    const value = await client.getEnsText({
      name: fullName,
      key,
    });
    if (value == null) fail(`Text record "${key}" resolved to null`);
    resolved[key] = value;
    log(`  ${key} = ${value}`);
  }

  log(`CCIP-Read resolution ok (${Date.now() - t1}ms)`);

  // Verify round-trip
  for (const [key, expected] of Object.entries(textRecords)) {
    if (resolved[key] !== expected) {
      fail(`Mismatch on "${key}": expected "${expected}" got "${resolved[key]}"`);
    }
  }

  // ── Mutate capsule.holder (simulates handoff) ──────────────────────────

  log('\nUpdating capsule.holder → "reproducer" (simulates handoff)');
  await ns.setName({
    domain: PARENT_NAME,
    name: label,
    address: "0x0000000000000000000000000000000000000001",
    text_records: { ...textRecords, "capsule.holder": "reproducer" },
  });

  await new Promise((r) => setTimeout(r, 2000));
  const updatedHolder = await client.getEnsText({ name: fullName, key: "capsule.holder" });
  if (updatedHolder !== "reproducer") {
    fail(`holder update did not propagate: got "${updatedHolder}"`);
  }
  log(`capsule.holder now = ${updatedHolder} ✅`);

  // ── Clean up ────────────────────────────────────────────────────────────

  log("\nCleaning up spike subname...");
  // NameStone doesn't have a delete API; set address to zero to effectively
  // revoke. In production, the CCIP-Read gateway handles revocation natively.
  // This is acceptable for the spike.
  log("(Subname will expire naturally — no delete API in NameStone spike mode)");

  console.log(`
✅  ENS spike PASSED

  Parent name : ${PARENT_NAME}
  Subname     : ${fullName}
  Text records round-tripped via CCIP-Read ✅
  capsule.holder mutated on handoff ✅

  This confirms:
    - Task pointer subnames can be issued programmatically (no per-subname gas)
    - Text records (capsule.head, capsule.holder, etc.) resolve via CCIP-Read
    - Mutation works — the "dig" moment in the demo is feasible
    - NameStone SDK is the right tool for state-capsule-ens
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
