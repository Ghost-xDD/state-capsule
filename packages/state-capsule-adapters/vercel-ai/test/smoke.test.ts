/**
 * smoke.test.ts — Vercel AI SDK adapter smoke tests.
 * Uses in-memory StateCapsule; no real model or `ai` package required.
 */
import { describe, it, expect } from "vitest";
import { StateCapsule }         from "@ghostxd/state-capsule-sdk";
import { createCapsuleMiddleware } from "../src/index.js";

describe("vercel-ai adapter smoke", () => {
  it("onStepFinish creates a capsule on the first step", async () => {
    const sdk          = new StateCapsule();
    let checkpointed: unknown = null;
    const m = createCapsuleMiddleware(sdk, {
      taskId: "vai-1", holder: "agent",
      onCheckpoint: (c) => { checkpointed = c; },
    });

    await m.onStepFinish({ finishReason: "stop", text: "Here is the fix." });
    expect(checkpointed).not.toBeNull();
    const c = checkpointed as { task_id: string; facts: string[] };
    expect(c.task_id).toBe("vai-1");
    expect(c.facts).toContain("Here is the fix.");
  });

  it("multiple steps extend the capsule chain (facts accumulate)", async () => {
    const sdk = new StateCapsule();
    const m   = createCapsuleMiddleware(sdk, { taskId: "vai-2", holder: "agent" });

    await m.onStepFinish({ finishReason: "tool-calls", text: "Step one." });
    await m.onStepFinish({ finishReason: "stop",       text: "Step two." });

    const capsule = await m.restore();
    expect(capsule).not.toBeNull();
    expect(capsule!.facts).toContain("Step one.");
    expect(capsule!.facts).toContain("Step two.");
  });

  it("tool calls are recorded as decisions", async () => {
    const sdk = new StateCapsule();
    const m   = createCapsuleMiddleware(sdk, { taskId: "vai-3", holder: "agent" });

    await m.onStepFinish({
      finishReason: "tool-calls",
      toolCalls: [{ toolName: "run_tests", args: { path: "./src" } }],
    });

    const capsule = await m.restore();
    expect(capsule!.decisions.some(d => d.includes("run_tests"))).toBe(true);
  });

  it("restore returns null if no capsule exists", async () => {
    const m = createCapsuleMiddleware(new StateCapsule(), { taskId: "vai-none", holder: "agent" });
    expect(await m.restore()).toBeNull();
  });
});
