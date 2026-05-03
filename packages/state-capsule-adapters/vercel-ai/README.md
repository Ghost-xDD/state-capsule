# @ghostxd/state-capsule-adapter-vercel-ai

State Capsule checkpoint middleware for the [Vercel AI SDK](https://sdk.vercel.ai). Pass `middleware.onStepFinish` to `generateText` or `streamText` — every generation step is signed and persisted on 0G Storage, enabling kill-and-resume for multi-step agents.

```ts
import { generateText }          from "ai";
import { openai }                from "@ai-sdk/openai";
import { StateCapsule }          from "@ghostxd/state-capsule-sdk";
import { createCapsuleMiddleware } from "@ghostxd/state-capsule-adapter-vercel-ai";

const sdk        = new StateCapsule({ privateKey: process.env.CAPSULE_PRIVATE_KEY });
const middleware = createCapsuleMiddleware(sdk, { taskId: "patch-pr-99", holder: "agent" });

await generateText({
  model: openai("gpt-4o-mini"),
  prompt: "Fix the failing tests.",
  onStepFinish: middleware.onStepFinish,   // ← only change required
});

const capsule = await middleware.restore(); // full signed state after generation
```
