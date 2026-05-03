/**
 * OpenClaw adapter example.
 *
 * Demonstrates capsule-backed OpenClaw memory with in-memory storage.
 * Set ZEROG_* env vars + CAPSULE_PRIVATE_KEY to use real 0G Storage.
 *
 * Run: npx tsx examples/adapters/openclaw.ts
 */

import { StateCapsule }             from "@ghostxd/state-capsule-sdk";
import { createStateCapsuleMemory } from "@ghostxd/state-capsule-adapter-openclaw";

async function main(): Promise<void> {
  const sdk    = new StateCapsule();
  const memory = createStateCapsuleMemory(sdk, {
    taskId: `openclaw-example-${Date.now()}`,
    holder: "assistant",
    goal:   "Demonstrate capsule-backed OpenClaw memory",
  });

  // First turn: simulate OpenClaw memory flush
  const snap1 = await memory.write([
    "## Facts",
    "- User prefers TypeScript",
    "- Project uses pnpm workspaces",
    "",
    "## Decisions",
    "- Use strict mode throughout",
    "",
    "## Next Action",
    "open pull request",
  ].join("\n"));
  console.log(`[openclaw] capsule written: ${snap1.capsuleId}`);

  // Second turn: read then extend (simulates next OpenClaw session resuming)
  const context = await memory.read();
  console.log("[openclaw] restored memory:\n" + context + "\n");

  const snap2 = await memory.write(context + "\n- Added second fact during turn 2");
  console.log(`[openclaw] chain extended: ${snap2.capsuleId}`);
  console.log("[openclaw] done");
}

main().catch(console.error);
