/**
 * Vercel AI SDK adapter example.
 *
 * Demonstrates onStepFinish checkpointing without a real model.
 * Un-comment the generateText block and set OPENAI_API_KEY to run live.
 *
 * Run: npx tsx examples/adapters/vercel-ai.ts
 */

import { StateCapsule }            from "@state-capsule/sdk";
import { createCapsuleMiddleware } from "@state-capsule/adapter-vercel-ai";

async function main(): Promise<void> {
  const sdk        = new StateCapsule();
  const middleware = createCapsuleMiddleware(sdk, {
    taskId: `vai-example-${Date.now()}`,
    holder: "agent",
    goal:   "Demonstrate Vercel AI capsule checkpointing",
    onCheckpoint: (c) => console.log(`[vercel-ai] checkpoint: ${c.capsule_id}`),
  });

  // Simulate what generateText emits internally for each step
  await middleware.onStepFinish({
    finishReason: "tool-calls",
    text:         "Calling the test runner tool.",
    toolCalls:    [{ toolName: "run_tests", args: { path: "./src" } }],
  });

  await middleware.onStepFinish({
    finishReason: "stop",
    text:         "All tests pass. The patch is complete.",
  });

  const capsule = await middleware.restore();
  console.log("[vercel-ai] final capsule facts:", capsule?.facts);

  /* ── Real generateText usage (requires OPENAI_API_KEY + `ai` package) ─────
  import { generateText } from "ai";
  import { openai }       from "@ai-sdk/openai";

  await generateText({
    model:          openai("gpt-4o-mini"),
    prompt:         "Fix the failing tests in src/parser.ts",
    onStepFinish:   middleware.onStepFinish,
  });
  ─────────────────────────────────────────────────────────────────────────── */

  console.log("[vercel-ai] ✓ done");
}

main().catch(console.error);
