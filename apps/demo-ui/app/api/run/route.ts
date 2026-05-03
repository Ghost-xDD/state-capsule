import { NextRequest, NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { cloneAndPick } from "@/lib/repo-loader";
import * as runStore from "@/lib/run-store";
import {
  HOSTED_REPLAY_FILE,
  HOSTED_REPLAY_TASK_ID,
  HOSTED_REPLAY_TOTAL_FILES,
  isHostedReplayEnabled,
} from "@/lib/hosted-replay";

// apps/demo-ui is 2 levels deep → workspace root is 2 levels up
const WORKSPACE_ROOT = resolve(process.cwd(), "../..");

const DEMO_SCRIPT = resolve(
  WORKSPACE_ROOT,
  "examples/maintainer-swarm/src/scripts/demo-run.ts",
);

// Load .env from workspace root so LLM keys / 0G keys are available to the
// child process even when Next.js doesn't source them automatically.
function loadDotEnv(): Record<string, string> {
  const envPath = resolve(WORKSPACE_ROOT, ".env");
  if (!existsSync(envPath)) return {};
  const vars: Record<string, string> = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key) vars[key] = val;
  }
  return vars;
}

const DOT_ENV = loadDotEnv();

export async function POST(req: NextRequest) {
  let body: { repoUrl?: unknown };
  try {
    body = (await req.json()) as { repoUrl?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const repoUrl = typeof body.repoUrl === "string" ? body.repoUrl.trim() : "";
  if (!repoUrl || !repoUrl.startsWith("https://github.com/")) {
    return NextResponse.json(
      { error: "Must be a https://github.com/… URL" },
      { status: 400 },
    );
  }

  if (isHostedReplayEnabled()) {
    return NextResponse.json({
      taskId: HOSTED_REPLAY_TASK_ID,
      relFile: HOSTED_REPLAY_FILE,
      totalFiles: HOSTED_REPLAY_TOTAL_FILES,
      replay: true,
    });
  }

  // Clone the repo and find the best source file
  let file: string, relFile: string, totalFiles: number;
  try {
    ({ file, relFile, totalFiles } = await cloneAndPick(repoUrl));
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }

  const taskId = crypto.randomUUID();
  runStore.create(taskId, repoUrl, relFile);

  // Append a synthetic banner line so the UI can show repo info before the
  // child process prints anything.
  runStore.append(
    taskId,
    `[demo-ui] Cloned ${repoUrl} (${totalFiles} source files found)\n` +
    `[demo-ui] Target file: ${relFile}\n`,
  );

  const SWARM_ROOT = resolve(WORKSPACE_ROOT, "examples/maintainer-swarm");
  const TSX_BIN    = resolve(SWARM_ROOT, "node_modules/.bin/tsx");

  // Spawn tsx directly — no pnpm, no workspace filter, no PATH dependency.
  const child = spawn(TSX_BIN, [DEMO_SCRIPT], {
    cwd: SWARM_ROOT,
    env: {
      ...DOT_ENV,
      ...process.env,   // process.env wins so live CLI overrides still apply
      BUGGY_UTILS_PATH: file,
      DEMO_TASK_ID: taskId,
      STATE_CAPSULE_MODE:
        process.env["STATE_CAPSULE_MODE"] ??
        DOT_ENV["STATE_CAPSULE_MODE"] ??
        "live",
      FORCE_COLOR: "0",
    },
    shell: false,
  });

  child.stdout.on("data", (chunk: Buffer) =>
    runStore.append(taskId, chunk.toString()),
  );
  child.stderr.on("data", (chunk: Buffer) =>
    runStore.append(taskId, chunk.toString()),
  );
  child.on("close", (code: number | null) => {
    runStore.markDone(
      taskId,
      code !== 0 ? `Process exited with code ${code ?? "?"}` : undefined,
    );
  });
  child.on("error", (err) => {
    runStore.append(taskId, `[demo-ui] Failed to spawn pipeline: ${err.message}\n`);
    runStore.markDone(taskId, err.message);
  });

  return NextResponse.json({ taskId, relFile, totalFiles });
}
