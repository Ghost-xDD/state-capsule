# @state-capsule/adapter-openclaw

Drop-in State Capsule memory backend for [OpenClaw](https://docs.openclaw.ai) agents. Every memory flush is checkpointed as a signed capsule on 0G Storage, giving each OpenClaw session cryptographic continuity and cross-process restore.

```ts
import { StateCapsule }           from "@state-capsule/sdk";
import { createStateCapsuleMemory } from "@state-capsule/adapter-openclaw";

const sdk    = new StateCapsule({ privateKey: process.env.CAPSULE_PRIVATE_KEY });
const memory = createStateCapsuleMemory(sdk, { taskId: "session-abc", holder: "assistant" });

// Read latest memory (inject into OpenClaw system prompt)
const context = await memory.read();

// Write updated memory after a turn (called from OpenClaw's memory flush hook)
await memory.write(context + "\n## Facts\n- user prefers TypeScript");
```
