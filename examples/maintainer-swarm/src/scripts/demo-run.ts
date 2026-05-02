#!/usr/bin/env tsx
/**
 * demo-run.ts — In-process MaintainerSwarm pipeline runner.
 *
 * Demonstrates the full State Capsule lifecycle in a single Node.js process:
 *
 *   1. Genesis capsule created (written to 0G Storage + anchored on-chain)
 *   2. Triager   — identifies bugs in buggy-utils
 *   3. Reproducer — plans tests (STEP 1), then container is "killed"
 *                   ↳ 💀 kill-and-resume demo ↱
 *   4. Reproducer — fresh container restores checkpoint from 0G, skips step 1
 *   5. Patcher   — generates patch
 *   6. Reviewer  — approves or requests rework
 *   7. 0G Compute — sealed inference summary of the capsule chain
 *   8. ENS       — final task pointer published to maintainerswarm.eth
 *
 * Modes (set STATE_CAPSULE_MODE env var):
 *   live    — real LLM calls, no recording  (default)
 *   record  — real LLM calls + transcript saved to TRANSCRIPT_PATH
 *   replay  — reads from transcript, no LLM keys required
 *
 * Storage:
 *   Set OG_PRIVATE_KEY (+ optional OG_* overrides) to write to 0G testnet.
 *   Falls back to in-memory storage if OG_PRIVATE_KEY is absent.
 */

import { fileURLToPath }  from "node:url";
import { resolve, dirname } from "node:path";
import {
  StateCapsule,
  createMemoryStorage,
  fetchSealedSummary,
  ZeroGConfigSchema,
} from "@state-capsule/sdk";
import type { Capsule, UpdateCapsuleInput, ZeroGConfig, ChainConfig } from "@state-capsule/sdk";
import {
  createRegistrarFromEnv,
  buildEnsUpdateHook,
  taskLabel,
} from "@state-capsule/ens";
import { triagerHandler }    from "../handlers/triager.js";
import { reproducerHandler } from "../handlers/reproducer.js";
import { patcherHandler }    from "../handlers/patcher.js";
import { reviewerHandler }   from "../handlers/reviewer.js";
import type { HandlerResult, AgentRole, CheckpointFn } from "../runtime.js";

// ── Config ────────────────────────────────────────────────────────────────────

const __dirname      = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(__dirname, "../../../..");
const MODE    = process.env["STATE_CAPSULE_MODE"] ?? "live";
// Fixed task_id keeps transcript tags stable across record → replay cycles.
const TASK_ID = process.env["DEMO_TASK_ID"] ?? "demo-golden";

// ── 0G Storage config (from env) ─────────────────────────────────────────────

const OG_PRIVATE_KEY = process.env["OG_PRIVATE_KEY"];

function buildZeroGConfig(): ZeroGConfig | undefined {
  if (!OG_PRIVATE_KEY) return undefined;
  return ZeroGConfigSchema.parse({
    privateKey:   OG_PRIVATE_KEY,
    evmRpc:       process.env["OG_EVM_RPC"],
    indexerRpc:   process.env["OG_INDEXER_RPC"],
    flowContract: process.env["OG_FLOW_CONTRACT"],
    kvClientUrl:  process.env["OG_KV_CLIENT_URL"],
  });
}

function buildChainConfig(): ChainConfig | undefined {
  if (!OG_PRIVATE_KEY) return undefined;
  return {
    privateKey: OG_PRIVATE_KEY,
    ...(process.env["OG_EVM_RPC"] ? { rpcUrl: process.env["OG_EVM_RPC"] } : {}),
  };
}

// ── ENS hook ──────────────────────────────────────────────────────────────────

const ensRegistrar = createRegistrarFromEnv();
const ensHook      = buildEnsUpdateHook(ensRegistrar);

// ── SDK ───────────────────────────────────────────────────────────────────────

const zeroGConfig = buildZeroGConfig();
const chainConfig = buildChainConfig();

const sdk = new StateCapsule({
  ...(OG_PRIVATE_KEY ? { privateKey: OG_PRIVATE_KEY } : {}),
  ...(zeroGConfig    ? { storage:    zeroGConfig    } : { storageAdapter: createMemoryStorage() }),
  ...(chainConfig    ? { chain:      chainConfig    } : {}),
  onAfterUpdate: async (capsule) => {
    await ensHook({
      task_id:     capsule.task_id,
      capsule_id:  capsule.capsule_id,
      holder:      capsule.holder,
      log_root:    capsule.log_root,
      next_action: capsule.next_action,
    });
  },
});

// ── Pretty output ─────────────────────────────────────────────────────────────

const C = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  cyan:   "\x1b[36m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  red:    "\x1b[31m",
  blue:   "\x1b[34m",
  magenta:"\x1b[35m",
};

function banner(title: string): void {
  const bar = "═".repeat(60);
  console.log(`\n${C.bold}${C.cyan}${bar}${C.reset}`);
  console.log(`${C.bold}${C.cyan}  ${title}${C.reset}`);
  console.log(`${C.bold}${C.cyan}${bar}${C.reset}\n`);
}

function phase(label: string, role: AgentRole | "compute" | "ens"): void {
  console.log(`${C.bold}${C.blue}▶ Phase: ${label}${C.reset}  ${C.dim}[${role}]${C.reset}`);
}

function ok(msg: string):   void { console.log(`  ${C.green}✓${C.reset} ${msg}`); }
function info(msg: string): void { console.log(`  ${C.dim}→${C.reset} ${msg}`); }
function warn(msg: string): void { console.log(`  ${C.yellow}⚠${C.reset}  ${msg}`); }
function kill(msg: string): void { console.log(`\n  ${C.red}${C.bold}💀 ${msg}${C.reset}\n`); }
function resume(msg: string): void { console.log(`  ${C.magenta}🔄 ${msg}${C.reset}`); }

// ── Pipeline helpers ──────────────────────────────────────────────────────────

function makeEnvelope(capsule: Capsule) {
  return {
    type:       "capsule.handoff" as const,
    task_id:    capsule.task_id,
    capsule_id: capsule.capsule_id,
    holder:     capsule.holder as AgentRole,
    sent_at:    new Date().toISOString(),
  };
}

async function advance(capsule: Capsule, result: HandlerResult): Promise<Capsule> {
  const update: UpdateCapsuleInput = {
    task_id:           capsule.task_id,
    parent_capsule_id: capsule.capsule_id,
    ...result.update,
  };
  return sdk.updateCapsule(update);
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  banner(`State Capsule  ×  MaintainerSwarm Demo  [${MODE} mode]`);
  info(`task_id  : ${TASK_ID}`);
  info(`storage  : ${zeroGConfig ? "0G testnet (real)" : "in-memory (fallback)"}`);
  info(`chain    : ${chainConfig ? "0G EVM testnet"   : "disabled"}`);
  info(`ens      : ${ensRegistrar ? `${process.env["ENS_PARENT_NAME"] ?? "?"}` : "disabled"}`);
  info(`compute  : ${process.env["OG_COMPUTE_SERVICE_URL"] ? "0G Compute" : "local fallback"}`);
  info(`buggy    : ${process.env["BUGGY_UTILS_PATH"]}`);
  console.log();

  // ── 1. Genesis capsule ─────────────────────────────────────────────────────
  info("Creating genesis capsule…");
  const genesis = await sdk.createCapsule({
    task_id:     TASK_ID,
    goal:        "Find and fix all bugs in the buggy-utils library",
    holder:      "triager",
    next_action: "triage",
  });
  ok(`genesis capsule : ${genesis.capsule_id.slice(0, 20)}…`);

  // ── 2. Triager ─────────────────────────────────────────────────────────────
  phase("Triager — bug identification", "triager");
  const triagerResult = await triagerHandler({
    capsule:  genesis,
    role:     "triager",
    envelope: makeEnvelope(genesis),
  });
  const afterTriager = await advance(genesis, triagerResult);
  ok(`triager done → ${triagerResult.next_holder}`);
  info(`capsule : ${afterTriager.capsule_id.slice(0, 20)}…`);

  // ── 3. Reproducer — Step 1 + simulated kill ────────────────────────────────
  phase("Reproducer — step 1 (planning) + 💀 kill demo", "reproducer");

  let checkpointCapsule: Capsule | null = null;

  const killAfterCheckpoint: CheckpointFn = async (partial) => {
    const persisted = await sdk.updateCapsule({
      task_id:           TASK_ID,
      parent_capsule_id: afterTriager.capsule_id,
      ...partial,
    });
    checkpointCapsule = persisted;
    ok(`step-1 checkpoint → 0G : ${persisted.capsule_id.slice(0, 20)}…`);
    // Simulate container death mid-execution.
    throw Object.assign(new Error("DEMO_KILL"), { _demoKill: true });
  };

  try {
    await reproducerHandler({
      capsule:    afterTriager,
      role:       "reproducer",
      envelope:   makeEnvelope(afterTriager),
      checkpoint: killAfterCheckpoint,
    });
  } catch (err: unknown) {
    const e = err as { _demoKill?: boolean };
    if (!e._demoKill) throw err;
    kill("Container killed after step-1 checkpoint  (kill-and-resume demo)");
  }

  if (!checkpointCapsule) throw new Error("Checkpoint was not written — unexpected");
  const ckpt: Capsule = checkpointCapsule;

  // ── 4. Reproducer — fresh container resumes from 0G ────────────────────────
  phase("Reproducer — fresh container resumes from 0G", "reproducer");
  resume("Booting fresh container…");
  resume(`Restoring capsule from 0G : ${ckpt.capsule_id.slice(0, 20)}…`);
  resume("Detected [reproducer:step] planning-done → skipping step 1");
  console.log();

  const resumeResult = await reproducerHandler({
    capsule:  ckpt,
    role:     "reproducer",
    envelope: makeEnvelope(ckpt),
  });
  const afterReproducer = await advance(ckpt, resumeResult);
  ok(`reproducer done → ${resumeResult.next_holder}`);
  info(`capsule : ${afterReproducer.capsule_id.slice(0, 20)}…`);

  // ── 5. Patcher ─────────────────────────────────────────────────────────────
  phase("Patcher — generate fix", "patcher");
  const patcherResult = await patcherHandler({
    capsule:  afterReproducer,
    role:     "patcher",
    envelope: makeEnvelope(afterReproducer),
  });
  const afterPatcher = await advance(afterReproducer, patcherResult);
  ok(`patcher done → ${patcherResult.next_holder}`);
  info(`capsule : ${afterPatcher.capsule_id.slice(0, 16)}…`);

  // ── 6. Reviewer ────────────────────────────────────────────────────────────
  phase("Reviewer — final verdict", "reviewer");
  const reviewerResult = await reviewerHandler({
    capsule:  afterPatcher,
    role:     "reviewer",
    envelope: makeEnvelope(afterPatcher),
  });
  const final = await advance(afterPatcher, reviewerResult);

  const verdict = final.next_action ?? reviewerResult.update.next_action ?? "?";
  if (verdict === "pipeline-complete") {
    ok(`${C.green}${C.bold}APPROVED${C.reset}${C.green} — pipeline complete${C.reset}`);
  } else {
    warn(`verdict: ${verdict}`);
  }
  info(`capsule : ${final.capsule_id.slice(0, 20)}…`);

  // ── 7. 0G Compute — sealed inference summary ───────────────────────────────
  phase("0G Compute — sealed inference summary", "compute");
  try {
    const summary = await fetchSealedSummary(final);
    if (summary.attested) {
      ok(`attested  : ${summary.model}  confidence=${summary.confidence}`);
      ok(`summary   : ${summary.summary.slice(0, 90)}…`);
    } else {
      info(`local fallback (no OG_COMPUTE_SERVICE_URL): ${summary.summary.slice(0, 80)}…`);
    }
  } catch (err) {
    warn(`sealed summary failed (non-fatal): ${err}`);
  }

  // ── 8. ENS — task pointer ──────────────────────────────────────────────────
  phase("ENS — task pointer", "ens");
  if (ensRegistrar) {
    const label = taskLabel(TASK_ID);
    ok(`published : ${label}.${process.env["ENS_PARENT_NAME"] ?? "??"}`);
    ok(`holder    : ${final.holder}  status: ${verdict === "pipeline-complete" ? "done" : "active"}`);
  } else {
    info("skipped (NAMESTONE_API_KEY not set)");
  }

  // ── 9. Summary ─────────────────────────────────────────────────────────────
  banner("Demo complete");
  ok(`task_id  : ${TASK_ID}`);
  ok(`mode     : ${MODE}`);
  ok(`storage  : ${zeroGConfig ? "0G testnet" : "in-memory"}`);
  ok(`capsules : 5  (genesis + triager + reproducer×2 + patcher + reviewer)`);
  ok(`verdict  : ${verdict}`);

  console.log(`\n${C.dim}Key capsule facts (final):${C.reset}`);
  for (const fact of final.facts.slice(-5)) {
    console.log(`  ${C.dim}•${C.reset} ${fact.slice(0, 110)}`);
  }
  console.log();
}

main().catch((err) => {
  console.error("\n\x1b[31m[demo-run] Fatal error:\x1b[0m", err);
  process.exit(1);
});
