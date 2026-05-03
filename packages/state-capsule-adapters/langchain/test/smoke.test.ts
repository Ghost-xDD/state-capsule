/**
 * smoke.test.ts - LangChain adapter smoke tests.
 * Uses in-memory StateCapsule and a fake Runnable (no real LLM required).
 */
import { describe, it, expect } from "vitest";
import { StateCapsule }         from "@ghostxd/state-capsule-sdk";
import { StateCapsuleMemory, withCapsuleMemory } from "../src/index.js";

describe("langchain adapter smoke", () => {
  it("loadMemoryVariables returns empty string before first save", async () => {
    const mem  = new StateCapsuleMemory(new StateCapsule(), { taskId: "lc-1", holder: "agent" });
    const vars = await mem.loadMemoryVariables({});
    expect(vars["capsule_context"]).toBe("");
  });

  it("saveContext + loadMemoryVariables round-trip", async () => {
    const mem = new StateCapsuleMemory(new StateCapsule(), { taskId: "lc-2", holder: "agent" });
    await mem.saveContext({ input: "find the root cause" }, { output: "stack overflow" });
    const vars = await mem.loadMemoryVariables({});
    expect(vars["capsule_context"]).toContain("find the root cause");
    expect(vars["capsule_context"]).toContain("stack overflow");
  });

  it("uses the configured memoryKey", async () => {
    const mem  = new StateCapsuleMemory(new StateCapsule(), {
      taskId: "lc-3", holder: "agent", memoryKey: "my_memory",
    });
    expect(mem.memoryKeys).toContain("my_memory");
    await mem.saveContext({ input: "ping" }, { output: "pong" });
    const vars = await mem.loadMemoryVariables({});
    expect(vars["my_memory"]).toContain("ping");
  });

  it("withCapsuleMemory checkpoints after invoke and returns the original output", async () => {
    const sdk     = new StateCapsule();
    const mem     = new StateCapsuleMemory(sdk, { taskId: "lc-4", holder: "agent" });
    const fake    = { invoke: async (q: string) => `echo:${q}` };
    const wrapped = withCapsuleMemory(fake, mem, {
      toInput:  (i) => ({ input: i }),
      toOutput: (o) => ({ output: o }),
    });

    const result = await wrapped.invoke("hello");
    expect(result).toBe("echo:hello");

    const vars = await mem.loadMemoryVariables({});
    expect(vars["capsule_context"]).toContain("hello");
    expect(vars["capsule_context"]).toContain("echo:hello");
  });
});
