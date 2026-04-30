/**
 * resolve-task.ts — Show ENS task-pointer records in a dig-like format.
 *
 * Usage (from repo root):
 *   TASK_ID=<task_id>  tsx scripts/resolve-task.ts
 *   -- or --
 *   tsx scripts/resolve-task.ts <task_id>
 *
 * Output mirrors what `dig <name>.maintainerswarm.eth TXT` would show
 * if the name were in DNS — formatted so demo observers can read it quickly.
 *
 * Requires:
 *   NAMESTONE_API_KEY   in .env
 *   ENS_PARENT_NAME     in .env  (default: maintainerswarm.eth)
 */

import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../.env"), override: true });

// ── Config ────────────────────────────────────────────────────────────────────

const TASK_ID   = process.argv[2] ?? process.env["TASK_ID"] ?? "";
const API_KEY   = process.env["NAMESTONE_API_KEY"] ?? "";
const DOMAIN    = process.env["ENS_PARENT_NAME"]   ?? "maintainerswarm.eth";
const NETWORK   = process.env["ENS_NETWORK"]       ?? "sepolia";
const NS_BASE   = NETWORK === "mainnet"
  ? "https://namestone.com/api/public_v1"
  : "https://namestone.com/api/public_v1_sepolia";

if (!TASK_ID) {
  console.error("Usage: tsx scripts/resolve-task.ts <task_id>");
  process.exit(1);
}

// ── Label ─────────────────────────────────────────────────────────────────────

function taskLabel(task_id: string): string {
  const slug = task_id.replace(/-/g, "").slice(0, 8);
  return `task-${slug}`;
}

// ── NameStone fetch ───────────────────────────────────────────────────────────

async function fetchRecords(label: string): Promise<Record<string, string> | null> {
  const url = `${NS_BASE}/get-names?domain=${encodeURIComponent(DOMAIN)}&text_records=1&limit=1000`;
  const res = await fetch(url, {
    headers: { Authorization: API_KEY },
    signal:  AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`NameStone HTTP ${res.status}: ${await res.text()}`);

  const names = await res.json() as Array<{ name: string; text_records?: Record<string, string> }>;
  const match = names.find((n) => n.name === label);
  return match ? (match.text_records ?? {}) : null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const label    = taskLabel(TASK_ID);
  const fullName = `${label}.${DOMAIN}`;

  console.log(`\n; <<>> dig (ENS CCIP-Read) <<>>`);
  console.log(`; QUESTION SECTION:`);
  console.log(`;${fullName}.\t\t\tIN\tTXT\n`);

  if (!API_KEY) {
    console.log("; NAMESTONE_API_KEY not set — cannot resolve");
    console.log(`; To resolve manually: https://namestone.com dashboard → ${DOMAIN}`);
    return;
  }

  const records = await fetchRecords(label);
  if (!records) {
    console.log("; ANSWER SECTION: (none — subname not found)");
    console.log(`;\n; Task pointer "${fullName}" has not been published yet.`);
    return;
  }

  const CAPSULE_FIELDS = [
    "capsule.head",
    "capsule.holder",
    "capsule.log_root",
    "capsule.status",
    "capsule.task_id",
  ];

  console.log("; ANSWER SECTION:");
  for (const field of CAPSULE_FIELDS) {
    const value = records[field];
    if (value !== undefined) {
      console.log(`${fullName}.\t\t0\tIN\tTXT\t"${field}=${value}"`);
    }
  }
  // Any extra records
  for (const [k, v] of Object.entries(records)) {
    if (!CAPSULE_FIELDS.includes(k)) {
      console.log(`${fullName}.\t\t0\tIN\tTXT\t"${k}=${v}"`);
    }
  }

  console.log(`\n;; Query time: 0 msec (NameStone CCIP-Read)`);
  console.log(`;; SERVER: namestone.com`);
  console.log(`;; WHEN: ${new Date().toUTCString()}`);
  console.log(`;; MSG SIZE: resolved\n`);

  // Summary line for easy scripting
  const holder = records["capsule.holder"] ?? "(unknown)";
  const status = records["capsule.status"] ?? "(unknown)";
  console.log(`HOLDER=${holder}  STATUS=${status}`);
}

main().catch((err) => {
  console.error(`[resolve-task] ERROR: ${err}`);
  process.exit(1);
});
