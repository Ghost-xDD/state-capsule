/**
 * smoke.test.ts - OpenClaw adapter smoke tests.
 * Uses in-memory StateCapsule (no 0G or OpenClaw runtime required).
 */
import { describe, it, expect } from "vitest";
import { StateCapsule }         from "@ghostxd/state-capsule-sdk";
import { createStateCapsuleMemory } from "../src/index.js";

describe("openclaw adapter smoke", () => {
  it("write/read round-trip preserves facts and next_action", async () => {
    const sdk = new StateCapsule();
    const mem = createStateCapsuleMemory(sdk, { taskId: "oc-1", holder: "agent" });

    const md      = "## Facts\n- sky is blue\n## Next Action\nrespond";
    const snap    = await mem.write(md);
    expect(snap.capsuleId).toBeTruthy();

    const restored = await mem.read();
    expect(restored).toContain("sky is blue");
    expect(restored).toContain("respond");
  });

  it("multiple writes build an immutable capsule chain", async () => {
    const sdk  = new StateCapsule();
    const mem  = createStateCapsuleMemory(sdk, { taskId: "oc-2", holder: "agent" });
    const snap1 = await mem.write("## Facts\n- first fact");
    const snap2 = await mem.write("## Facts\n- first fact\n- second fact");

    expect(snap2.capsuleId).not.toBe(snap1.capsuleId);
    expect(await mem.read()).toContain("second fact");
  });

  it("read returns empty string when no capsule exists yet", async () => {
    const mem = createStateCapsuleMemory(new StateCapsule(), { taskId: "oc-none", holder: "agent" });
    expect(await mem.read()).toBe("");
  });

  it("onWrite hook is called after each write", async () => {
    const capsuleIds: string[] = [];
    const mem = createStateCapsuleMemory(new StateCapsule(), {
      taskId: "oc-hook",
      holder: "agent",
      onWrite: (c) => { capsuleIds.push(c.capsule_id); },
    });
    await mem.write("## Facts\n- a");
    await mem.write("## Facts\n- a\n- b");
    expect(capsuleIds).toHaveLength(2);
  });
});
