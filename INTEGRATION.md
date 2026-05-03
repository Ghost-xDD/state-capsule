# State Capsule Integration Guide

State Capsule is a small continuity layer for agent runtimes. The normal integration shape is:

1. Restore the latest capsule before an agent starts work.
2. Run the framework, chain, tool call, or agent step.
3. Write a new capsule with the facts, decisions, pending actions, and next action.
4. Hand off by `task_id` and `capsule_id`, not by raw chat history.

The public SDK package is:

```bash
npm install @ghostxd/state-capsule-sdk
```

```ts
import { StateCapsule, createMemoryStorage } from "@ghostxd/state-capsule-sdk";
```

## Minimal SDK Integration

Use in-memory storage for local development:

```ts
import { StateCapsule, createMemoryStorage } from "@ghostxd/state-capsule-sdk";

const sdk = new StateCapsule({
  storageAdapter: createMemoryStorage(),
});

const first = await sdk.createCapsule({
  task_id: "task-123",
  goal: "Fix the failing tests",
  holder: "triager",
  facts: ["CI fails on parser.test.ts"],
  next_action: "reproduce failure",
});

const next = await sdk.updateCapsule({
  task_id: first.task_id,
  parent_capsule_id: first.capsule_id,
  holder: "reproducer",
  facts: [...first.facts, "Failure reproduces with empty input"],
  decisions: ["Write a focused regression test before patching"],
  pending_actions: ["create regression test", "patch parser"],
  next_action: "write regression test",
});

const restored = await sdk.restoreCapsule("task-123");
console.log(restored.capsule_id === next.capsule_id);
```

## 0G Storage and Chain

For production-style durability, pass 0G storage and chain config instead of `createMemoryStorage()`.

```ts
import { StateCapsule } from "@ghostxd/state-capsule-sdk";

const sdk = new StateCapsule({
  privateKey: process.env.OG_PRIVATE_KEY,
  storage: {
    privateKey: process.env.OG_PRIVATE_KEY!,
    evmRpc: process.env.OG_EVM_RPC,
    indexerRpc: process.env.OG_INDEXER_RPC,
    flowContract: process.env.OG_FLOW_CONTRACT,
    kvClientUrl: process.env.OG_KV_CLIENT_URL,
  },
  chain: {
    privateKey: process.env.OG_PRIVATE_KEY!,
    rpcUrl: process.env.OG_EVM_RPC,
  },
});
```

The SDK will sign capsules, write the capsule payload to storage, and best-effort anchor the capsule head on-chain.

## LangChain Pattern

Use the capsule as durable memory around a chain invocation. The repository also contains a LangChain adapter under `packages/state-capsule-adapters/langchain`; until that package is published, the pattern below works with the public SDK directly.

```ts
import { StateCapsule, createMemoryStorage } from "@ghostxd/state-capsule-sdk";

const sdk = new StateCapsule({ storageAdapter: createMemoryStorage() });
const taskId = "lc-ticket-42";

async function loadCapsuleContext() {
  try {
    const capsule = await sdk.restoreCapsule(taskId);
    return {
      capsule,
      context: [
        `Goal: ${capsule.goal}`,
        `Facts:\n${capsule.facts.map((fact) => `- ${fact}`).join("\n")}`,
        `Decisions:\n${capsule.decisions.map((decision) => `- ${decision}`).join("\n")}`,
        `Next: ${capsule.next_action}`,
      ].join("\n\n"),
    };
  } catch {
    const capsule = await sdk.createCapsule({
      task_id: taskId,
      goal: "Resolve the support ticket",
      holder: "langchain-agent",
      next_action: "call chain",
    });
    return { capsule, context: "" };
  }
}

const { capsule, context } = await loadCapsuleContext();

const result = await chain.invoke({
  input: "What should we do next?",
  capsule_context: context,
});

await sdk.updateCapsule({
  task_id: taskId,
  parent_capsule_id: capsule.capsule_id,
  holder: "langchain-agent",
  facts: [...capsule.facts, `chain result: ${String(result).slice(0, 500)}`],
  decisions: [...capsule.decisions, "Checkpointed LangChain result"],
  next_action: "continue workflow",
});
```

## OpenClaw Pattern

OpenClaw-style systems usually have a memory flush or turn summary. Store that summary as capsule fields.

```ts
import { StateCapsule, createMemoryStorage } from "@ghostxd/state-capsule-sdk";

const sdk = new StateCapsule({ storageAdapter: createMemoryStorage() });

function parseMemory(markdown: string) {
  const facts = [...markdown.matchAll(/^- fact: (.+)$/gim)].map((m) => m[1]!);
  const decisions = [...markdown.matchAll(/^- decision: (.+)$/gim)].map((m) => m[1]!);
  const pending_actions = [...markdown.matchAll(/^- todo: (.+)$/gim)].map((m) => m[1]!);
  const next_action = pending_actions[0] ?? "await user";
  return { facts, decisions, pending_actions, next_action };
}

const taskId = "openclaw-session-7";
const memoryMarkdown = [
  "- fact: user prefers TypeScript",
  "- fact: repo uses pnpm",
  "- decision: keep changes minimal",
  "- todo: write failing test",
].join("\n");

const fields = parseMemory(memoryMarkdown);

const capsule = await sdk.createCapsule({
  task_id: taskId,
  goal: "Persist OpenClaw working memory",
  holder: "openclaw-agent",
  ...fields,
});

const restored = await sdk.restoreCapsule(taskId);
console.log(restored.next_action);
```

## Vercel AI SDK Pattern

For Vercel AI SDK, checkpoint at step boundaries. The local adapter in `packages/state-capsule-adapters/vercel-ai` wraps this into middleware, but the public SDK can be used directly.

```ts
const capsule = await sdk.createCapsule({
  task_id: "ai-sdk-run-99",
  goal: "Generate a patch plan",
  holder: "vercel-ai-agent",
  next_action: "generate text",
});

await generateText({
  model,
  prompt: "Plan the parser fix.",
  async onStepFinish(step) {
    await sdk.updateCapsule({
      task_id: capsule.task_id,
      parent_capsule_id: capsule.capsule_id,
      holder: "vercel-ai-agent",
      facts: [`step text: ${step.text?.slice(0, 500) ?? ""}`],
      decisions: [`finish reason: ${step.finishReason}`],
      next_action: "review generated plan",
    });
  },
});
```

## ENS Task Pointers

Use `onAfterUpdate` to publish the latest capsule state to ENS or another resolver.

```ts
const sdk = new StateCapsule({
  storageAdapter: createMemoryStorage(),
  async onAfterUpdate(capsule) {
    await publishTaskPointer(capsule.task_id, {
      "capsule.head": capsule.capsule_id,
      "capsule.holder": capsule.holder,
      "capsule.log_root": capsule.log_root ?? "",
      "capsule.status": capsule.next_action === "pipeline-complete" ? "done" : "active",
    });
  },
});
```

## Handoff Verification

When one process hands work to another, send the capsule reference and verify the chain before continuing.

```ts
const chain = [genesis, triagerCapsule, reproducerCapsule];
const ok = await sdk.verifyHandoff(chain);

if (!ok) {
  throw new Error("Invalid capsule handoff");
}
```

## Practical Notes

- Use `createMemoryStorage()` in tests and local demos.
- Use 0G Storage and 0G Chain when fresh processes need to restore by `task_id`.
- Treat `facts` as verified observations, not raw chat logs.
- Put immediate work in `next_action`; put longer queues in `pending_actions`.
- Keep `holder` honest. It should name the role or process responsible for the next step.
- Write a capsule after every meaningful handoff, checkpoint, or irreversible decision.
