/**
 * LangChain adapter example.
 *
 * Demonstrates StateCapsuleMemory + withCapsuleMemory without a real LLM.
 * Set ZEROG_* env vars + CAPSULE_PRIVATE_KEY to use real 0G Storage.
 *
 * Run: npx tsx examples/adapters/langchain.ts
 */

import { StateCapsule }                         from "@ghostxd/state-capsule-sdk";
import { StateCapsuleMemory, withCapsuleMemory } from "@ghostxd/state-capsule-adapter-langchain";

async function main(): Promise<void> {
  const sdk    = new StateCapsule();
  const memory = new StateCapsuleMemory(sdk, {
    taskId: `lc-example-${Date.now()}`,
    holder: "agent",
    goal:   "Demonstrate LangChain capsule memory",
  });

  // Simulate first chain invocation
  await memory.saveContext(
    { input: "Find the root cause of the failing test" },
    { output: "Stack overflow in the recursive parser at line 42" },
  );
  console.log("[langchain] context saved");

  // Load context for the next step
  const vars = await memory.loadMemoryVariables({});
  console.log("[langchain] memory variables:\n" + vars["capsule_context"] + "\n");

  // Wrap a fake chain to demonstrate withCapsuleMemory
  const fakeChain = { invoke: async (q: string) => `Answering: ${q}` };
  const wrapped   = withCapsuleMemory(fakeChain, memory, {
    toInput:  (i) => ({ input: i }),
    toOutput: (o) => ({ output: o }),
  });

  const result = await wrapped.invoke("What should we do next?");
  console.log("[langchain] chain result:", result);
  console.log("[langchain] done");
}

main().catch(console.error);
